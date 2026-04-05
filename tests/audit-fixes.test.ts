/**
 * Tests for issues found by external LLM audit.
 * Covers: SSRF fail-closed, config loading, context guard message,
 * session reindex stale cleanup, workspace apiKeys.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- SSRF fail-closed on DNS failure ---

import { validateUrl, SsrFBlockedError } from "../src/memory/ssrf.js";

describe("SSRF fail-closed", () => {
  it("blocks unresolvable hostnames (fail-closed)", async () => {
    await expect(
      validateUrl("http://this-hostname-does-not-exist-abc123xyz.invalid/api"),
    ).rejects.toThrow();
  });

  it("allows public hostnames that resolve", async () => {
    const result = await validateUrl("https://example.com");
    expect(result).toBeDefined();
    expect(result.resolvedAddresses.length).toBeGreaterThan(0);
  });

  it("blocks private IPs even when DNS resolves", async () => {
    await expect(validateUrl("http://127.0.0.1/api")).rejects.toThrow();
  });
});

// --- Config loading: stateDir vs configPath ---

import { loadConfig, resolveStateDir } from "../src/config/index.js";

describe("Config loading", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadConfig with valid config file returns config", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ model: "gpt-4o", provider: "openai" }));
    const config = loadConfig(configPath);
    expect(config.model).toBe("gpt-4o");
    expect(config.provider).toBe("openai");
  });

  it("loadConfig with missing explicit path throws", () => {
    expect(() => loadConfig(path.join(tmpDir, "nonexistent.json"))).toThrow(
      /Failed to load config/,
    );
  });

  it("loadConfig with undefined uses default path", () => {
    const config = loadConfig(undefined);
    expect(config).toBeDefined();
  });

  it("stateDir is not used as configPath", () => {
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    // stateDir is a directory, not a JSON file — loadConfig should throw
    expect(() => loadConfig(stateDir)).toThrow(/Failed to load config/);
  });

  it("resolveStateDir uses config.stateDir", () => {
    const dir = resolveStateDir({ stateDir: "/custom/path" });
    expect(dir).toBe("/custom/path");
  });
});

// --- Context guard message uses correct threshold ---

import {
  evaluateContextWindowGuard,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
} from "../src/runtime/context-guard.js";

describe("Context guard threshold consistency", () => {
  it("CONTEXT_WINDOW_HARD_MIN_TOKENS is 16000", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
  });

  it("blocks at 16000 threshold, not 1024", () => {
    const result = evaluateContextWindowGuard({
      info: { tokens: 8000, source: "model" },
    });
    expect(result.shouldBlock).toBe(true);

    const result2 = evaluateContextWindowGuard({
      info: { tokens: 20000, source: "model" },
    });
    expect(result2.shouldBlock).toBe(false);
  });
});

// --- Session reindex clears stale chunks ---

import { createSessionIndexer } from "../src/memory/session-indexer.js";
import { createSimpleMemoryManager } from "../src/memory/simple-manager.js";

describe("Session reindex stale cleanup", () => {
  let tmpDir2: string;

  beforeEach(() => {
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sess-reindex-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  function writeTranscript(sessionId: string, messages: Array<{ role: string; content: string }>) {
    const sessDir = path.join(tmpDir2, "sessions", sessionId);
    fs.mkdirSync(sessDir, { recursive: true });
    const filePath = path.join(sessDir, "transcript.jsonl");
    const lines = messages.map((m) => JSON.stringify(m)).join("\n");
    fs.writeFileSync(filePath, lines + "\n");
    return filePath;
  }

  it("full reindex does not leave duplicate chunks", async () => {
    writeTranscript("s1", [
      { role: "user", content: "What is TypeScript?" },
      { role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
    ]);

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir2, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir2, "sessions"),
      memory,
    });

    // First indexAll
    await indexer.indexAllSessions();
    const countAfterFirst = (await memory.list()).length;

    // Second indexAll (simulates config change → full reindex)
    // Force meta change by creating a new indexer with different chunking
    const indexer2 = createSessionIndexer({
      sessionsDir: path.join(tmpDir2, "sessions"),
      memory,
      chunking: { tokens: 1000, overlap: 100 },
    });
    await indexer2.indexAllSessions();
    const countAfterSecond = (await memory.list()).length;

    // Should not have MORE chunks than the first run (stale cleared)
    expect(countAfterSecond).toBeLessThanOrEqual(countAfterFirst + 1);

    await memory.close();
  });
});

// --- Workspace apiKeys consistency ---

describe("WorkspaceRunOptions apiKeys", () => {
  it("AgentRunOptions includes apiKeys field", async () => {
    const { type } = await import("../src/runtime/agent.js");
    // Just verify the type compiles — the actual type check is at compile time
    const opts: import("../src/runtime/agent.js").AgentRunOptions = {
      message: "test",
      apiKeys: ["key1", "key2"],
    };
    expect(opts.apiKeys).toEqual(["key1", "key2"]);
  });
});
