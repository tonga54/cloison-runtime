import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createCredentialStore } from "../src/credentials/store.js";
import { createCredentialProxy } from "../src/credentials/proxy.js";

describe("CredentialStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and resolves credentials", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });

    await store.store("openai", { apiKey: "sk-test-123" });
    const resolved = await store.resolve("openai");

    expect(resolved).toEqual({ apiKey: "sk-test-123" });
  });

  it("stores credentials with multiple fields", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });

    await store.store("stripe", { secretKey: "sk_live_x", publishableKey: "pk_live_y" });
    const resolved = await store.resolve("stripe");

    expect(resolved).toEqual({ secretKey: "sk_live_x", publishableKey: "pk_live_y" });
  });

  it("never stores plaintext on disk", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });

    await store.store("openai", { apiKey: "sk-super-secret-key-12345" });

    const filePath = path.join(tmpDir, "credentials.enc.json");
    const raw = fs.readFileSync(filePath, "utf-8");

    expect(raw).not.toContain("sk-super-secret-key-12345");
    expect(raw).not.toContain("super-secret");
  });

  it("encrypted file has correct structure", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });

    await store.store("openai", { apiKey: "sk-test" });

    const filePath = path.join(tmpDir, "credentials.enc.json");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    expect(parsed.version).toBe(1);
    expect(parsed.credentials.openai).toHaveProperty("salt");
    expect(parsed.credentials.openai).toHaveProperty("iv");
    expect(parsed.credentials.openai).toHaveProperty("tag");
    expect(parsed.credentials.openai).toHaveProperty("ciphertext");
  });

  it("wrong passphrase cannot decrypt", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "correct-pass" });
    await store.store("openai", { apiKey: "sk-test" });

    const wrongStore = createCredentialStore({ workspaceDir: tmpDir, passphrase: "wrong-pass" });
    const result = await wrongStore.resolve("openai");

    expect(result).toBeUndefined();
  });

  it("returns undefined for nonexistent credential", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });
    const result = await store.resolve("nonexistent");

    expect(result).toBeUndefined();
  });

  it("deletes credentials", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });

    await store.store("openai", { apiKey: "sk-test" });
    expect(await store.delete("openai")).toBe(true);
    expect(await store.resolve("openai")).toBeUndefined();
  });

  it("delete returns false for nonexistent", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });
    expect(await store.delete("nonexistent")).toBe(false);
  });

  it("lists stored credential IDs", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });

    await store.store("openai", { apiKey: "a" });
    await store.store("anthropic", { apiKey: "b" });
    await store.store("stripe", { key: "c" });

    const list = await store.list();
    expect(list.sort()).toEqual(["anthropic", "openai", "stripe"]);
  });

  it("overwrites existing credential", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test-pass" });

    await store.store("openai", { apiKey: "old-key" });
    await store.store("openai", { apiKey: "new-key" });

    const resolved = await store.resolve("openai");
    expect(resolved).toEqual({ apiKey: "new-key" });
  });

  it("throws when no passphrase is available", () => {
    delete process.env["CLOISON_CREDENTIAL_KEY"];
    expect(() => createCredentialStore({ workspaceDir: tmpDir })).toThrow(
      "Credential store requires a passphrase",
    );
  });

  it("uses env var passphrase when none provided", async () => {
    process.env["CLOISON_CREDENTIAL_KEY"] = "env-passphrase";
    try {
      const store = createCredentialStore({ workspaceDir: tmpDir });
      await store.store("test", { key: "value" });

      const store2 = createCredentialStore({ workspaceDir: tmpDir });
      const result = await store2.resolve("test");
      expect(result).toEqual({ key: "value" });
    } finally {
      delete process.env["CLOISON_CREDENTIAL_KEY"];
    }
  });
});

describe("CredentialProxy", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("injects credentials into env", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test" });
    await store.store("openai", { API_KEY: "sk-injected" });

    const proxy = createCredentialProxy(store);
    const result = await proxy.injectCredentials("openai", { NODE_ENV: "prod" });

    expect(result.API_KEY).toBe("sk-injected");
    expect(result.NODE_ENV).toBe("prod");
  });

  it("passes through env when no credentials found", async () => {
    const store = createCredentialStore({ workspaceDir: tmpDir, passphrase: "test" });
    const proxy = createCredentialProxy(store);

    const result = await proxy.injectCredentials("nonexistent", { FOO: "bar" });

    expect(result).toEqual({ FOO: "bar" });
  });
});
