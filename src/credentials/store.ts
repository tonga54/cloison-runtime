import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { CredentialStore } from "./types.js";
import { atomicWriteFileSync } from "../shared/index.js";

let credentialLock: Promise<void> = Promise.resolve();

function withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = credentialLock;
  let release: () => void;
  credentialLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release!());
}

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;

interface EncryptedPayload {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface CredentialFile {
  version: 1;
  credentials: Record<string, EncryptedPayload>;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
}

function encrypt(plaintext: string, passphrase: string): EncryptedPayload {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, "utf-8", "base64");
  ciphertext += cipher.final("base64");
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext,
  };
}

function decrypt(payload: EncryptedPayload, passphrase: string): string {
  const salt = Buffer.from(payload.salt, "base64");
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let plaintext = decipher.update(payload.ciphertext, "base64", "utf-8");
  plaintext += decipher.final("utf-8");
  return plaintext;
}

export interface CreateCredentialStoreOptions {
  workspaceDir: string;
  passphrase?: string;
}

export function createCredentialStore(
  options: CreateCredentialStoreOptions,
): CredentialStore {
  const filePath = path.join(options.workspaceDir, "credentials.enc.json");
  const passphrase =
    options.passphrase ??
    process.env["CLOISON_CREDENTIAL_KEY"];

  if (!passphrase) {
    throw new Error(
      "Credential store requires a passphrase: pass it explicitly or set CLOISON_CREDENTIAL_KEY",
    );
  }

  const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  function validateSkillId(skillId: string): void {
    if (DANGEROUS_KEYS.has(skillId)) {
      throw new Error(`Invalid skillId "${skillId}": reserved property name`);
    }
  }

  function loadFile(): CredentialFile {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as CredentialFile;
    } catch {
      return { version: 1, credentials: {} };
    }
  }

  function saveFile(file: CredentialFile): void {
    atomicWriteFileSync(filePath, JSON.stringify(file, null, 2));
  }

  return {
    async store(skillId, credentials) {
      validateSkillId(skillId);
      return withCredentialLock(async () => {
        const file = loadFile();
        const plaintext = JSON.stringify(credentials);
        file.credentials[skillId] = encrypt(plaintext, passphrase);
        saveFile(file);
      });
    },

    async resolve(skillId) {
      validateSkillId(skillId);
      const file = loadFile();
      const payload = file.credentials[skillId];
      if (!payload) return undefined;
      try {
        const plaintext = decrypt(payload, passphrase);
        return JSON.parse(plaintext) as Record<string, string>;
      } catch (err) {
        process.stderr.write(
          `[credential-store] Failed to decrypt credentials for skill "${skillId}": ${err instanceof Error ? err.message : String(err)}. ` +
          `This typically means the passphrase has changed since the credentials were stored.\n`,
        );
        return undefined;
      }
    },

    async delete(skillId) {
      validateSkillId(skillId);
      return withCredentialLock(async () => {
        const file = loadFile();
        if (!(skillId in file.credentials)) return false;
        delete file.credentials[skillId];
        saveFile(file);
        return true;
      });
    },

    async list() {
      const file = loadFile();
      return Object.keys(file.credentials);
    },
  };
}
