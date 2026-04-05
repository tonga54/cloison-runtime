/**
 * Demo: Sandbox capabilities and credential security
 *
 * Shows:
 * - Platform capability detection (namespaces, cgroups, seccomp)
 * - AES-256-GCM credential encryption with PBKDF2 key derivation
 * - Wrong passphrase cannot decrypt (auth tag verification)
 * - Credential proxy injects secrets without exposing them
 * - Linux namespace isolation layers
 * - Environment sanitization (credential keys stripped)
 *
 * Run: npx tsx demos/demo-sandbox-capabilities.ts
 * Note: Must run on Linux or inside Docker (docker compose run dev)
 */
import { detectCapabilities, createSandboxManager } from "../src/sandbox/index.js";
import { createCredentialStore, createCredentialProxy } from "../src/credentials/index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

async function main() {
  console.log("=== Sandbox & Security Demo ===\n");

  // --- Platform capabilities ---
  console.log("--- Platform Capabilities ---");
  const caps = detectCapabilities();
  console.log("Platform:", caps.platform);
  console.log("User namespaces:", caps.hasUserNamespace);
  console.log("PID namespaces:", caps.hasPidNamespace);
  console.log("Mount namespaces:", caps.hasMountNamespace);
  console.log("Network namespaces:", caps.hasNetNamespace);
  console.log("cgroup v2:", caps.hasCgroupV2);
  console.log("seccomp:", caps.hasSeccomp);
  console.log("unshare binary:", caps.hasUnshare);

  const sandboxReady = caps.platform === "linux" && caps.hasUnshare && caps.hasMountNamespace;
  console.log("\nSandbox ready?", sandboxReady);
  if (sandboxReady) {
    console.log("  → Agents run inside isolated rootfs with coding tools (read/write/edit/bash)");
    console.log("  → Each agent gets: user ns + mount ns + PID ns + cgroups v2");
  } else {
    console.log("  → ERROR: Cloison Runtime requires Linux with namespace support.");
    console.log("  → Run inside Docker: docker compose run dev");
  }

  // --- Credential encryption ---
  console.log("\n--- Credential Encryption (AES-256-GCM + PBKDF2) ---");
  const tmpDir = path.join(os.tmpdir(), `cloison-runtime-cred-demo-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const store = createCredentialStore({
    workspaceDir: tmpDir,
    passphrase: "my-secure-passphrase-2026",
  });

  await store.store("openai", { apiKey: "sk-proj-abc123def456" });
  await store.store("anthropic", { apiKey: "sk-ant-xyz789" });
  await store.store("stripe", { secretKey: "sk_live_example", publishableKey: "pk_live_example" });

  const encFile = path.join(tmpDir, "credentials.enc.json");
  const raw = fs.readFileSync(encFile, "utf-8");
  const parsed = JSON.parse(raw);

  console.log("Stored credentials:", Object.keys(parsed.credentials));
  console.log("Each entry contains:", Object.keys(parsed.credentials.openai));
  console.log("Plaintext 'sk-proj' visible in file?", raw.includes("sk-proj"), "(should be false)");
  console.log("Plaintext 'sk-ant' visible in file?", raw.includes("sk-ant"), "(should be false)");
  console.log("Plaintext 'sk_live' visible in file?", raw.includes("sk_live"), "(should be false)");

  // --- Decryption ---
  console.log("\n--- Decryption ---");
  const openai = await store.resolve("openai");
  const stripe = await store.resolve("stripe");
  console.log("OpenAI key matches?", openai?.apiKey === "sk-proj-abc123def456");
  console.log("Stripe has 2 fields?", stripe && Object.keys(stripe).length === 2);
  console.log("Nonexistent credential?", await store.resolve("aws") === undefined);

  // --- Wrong passphrase ---
  console.log("\n--- Wrong Passphrase ---");
  const wrongStore = createCredentialStore({
    workspaceDir: tmpDir,
    passphrase: "wrong-passphrase",
  });
  const leaked = await wrongStore.resolve("openai");
  console.log("Wrong passphrase decrypts?", leaked !== undefined, "(should be false)");

  // --- Credential proxy ---
  console.log("\n--- Credential Proxy ---");
  const proxy = createCredentialProxy(store);

  const injected = await proxy.injectCredentials("openai", {
    NODE_ENV: "production",
    PATH: "/usr/bin",
  });
  console.log("Proxy injected apiKey?", "apiKey" in injected);
  console.log("Proxy preserved NODE_ENV?", injected.NODE_ENV === "production");
  console.log("Proxy preserved PATH?", injected.PATH === "/usr/bin");

  const noCredsEnv = await proxy.injectCredentials("nonexistent", { FOO: "bar" });
  console.log("No-creds passthrough?", Object.keys(noCredsEnv).length === 1 && noCredsEnv.FOO === "bar");

  // --- Credential deletion ---
  console.log("\n--- Credential Lifecycle ---");
  console.log("Before delete:", await store.list());
  await store.delete("stripe");
  console.log("After delete:", await store.list());
  console.log("Stripe resolves?", (await store.resolve("stripe")) === undefined);

  // --- Sandbox manager ---
  console.log("\n--- Sandbox Manager ---");
  const manager = createSandboxManager();
  const managerCaps = await manager.capabilities();
  console.log("Manager platform:", managerCaps.platform);

  if (managerCaps.platform === "linux" && managerCaps.hasUnshare) {
    console.log("Sandbox mode: Linux namespaces + cgroups");
    console.log("  Agents run inside: unshare --user --mount --pid --fork");
    console.log("  Filesystem: pivot_root to isolated rootfs");
    console.log("  Resource limits: cgroup v2 (memory, CPU, PIDs)");
    console.log("  Env sanitization: allowlist-only (PATH, HOME, NODE_ENV + provider key)");
  } else {
    console.log("ERROR: Linux with namespace support is required.");
    console.log("  Run: docker compose run dev");
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\nDemo complete.");
}

main().catch(console.error);
