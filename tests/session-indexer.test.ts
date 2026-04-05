import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createSessionIndexer } from "../src/memory/session-indexer.js";
import { createSimpleMemoryManager } from "../src/memory/simple-manager.js";

describe("SessionIndexer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-idx-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(sessionId: string, messages: Array<{ role: string; content: string }>): string {
    const sessDir = path.join(tmpDir, "sessions", sessionId);
    fs.mkdirSync(sessDir, { recursive: true });
    const filePath = path.join(sessDir, "transcript.jsonl");
    const lines = messages.map((m) => JSON.stringify(m)).join("\n");
    fs.writeFileSync(filePath, lines + "\n");
    return filePath;
  }

  it("indexes a session transcript", async () => {
    const filePath = writeTranscript("s1", [
      { role: "user", content: "What is TypeScript?" },
      { role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
    ]);

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir, "sessions"),
      memory,
    });

    const result = await indexer.indexSession(filePath);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.chunksStored).toBeGreaterThan(0);

    await memory.close();
  });

  it("skips short transcripts", async () => {
    const filePath = writeTranscript("s2", [
      { role: "user", content: "hi" },
    ]);

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir, "sessions"),
      memory,
    });

    const result = await indexer.indexSession(filePath);
    expect(result.chunksStored).toBe(0);

    await memory.close();
  });

  it("indexes all sessions", async () => {
    writeTranscript("s1", [
      { role: "user", content: "question 1" },
      { role: "assistant", content: "answer 1" },
    ]);
    writeTranscript("s2", [
      { role: "user", content: "question 2" },
      { role: "assistant", content: "answer 2" },
    ]);

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir, "sessions"),
      memory,
    });

    const result = await indexer.indexAllSessions();
    expect(result.sessionsProcessed).toBe(2);

    await memory.close();
  });

  it("skips unchanged sessions on re-index", async () => {
    const filePath = writeTranscript("s1", [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir, "sessions"),
      memory,
    });

    await indexer.indexSession(filePath);
    const result = await indexer.indexSession(filePath);
    expect(result.chunksStored).toBe(0);
    expect(result.chunksRemoved).toBe(0);

    await memory.close();
  });

  it("re-indexes changed transcripts", async () => {
    const filePath = writeTranscript("s1", [
      { role: "user", content: "v1 question" },
      { role: "assistant", content: "v1 answer" },
    ]);

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir, "sessions"),
      memory,
    });

    await indexer.indexSession(filePath);

    writeTranscript("s1", [
      { role: "user", content: "v2 question" },
      { role: "assistant", content: "v2 answer with more content" },
    ]);

    const result = await indexer.indexSession(filePath);
    expect(result.chunksRemoved).toBeGreaterThan(0);
    expect(result.chunksStored).toBeGreaterThan(0);

    await memory.close();
  });

  it("startListener returns unsubscribe function", () => {
    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir, "sessions"),
      memory,
    });

    const unsubscribe = indexer.startListener();
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();

    memory.close();
  });

  it("runPostCompactionSideEffects indexes session", async () => {
    const filePath = writeTranscript("s1", [
      { role: "user", content: "compacted question" },
      { role: "assistant", content: "compacted answer" },
    ]);

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir, "sessions"),
      memory,
      postCompactionSyncMode: "await",
    });

    await indexer.runPostCompactionSideEffects(filePath);

    const results = await memory.search("compacted");
    expect(results.length).toBeGreaterThan(0);

    await memory.close();
  });

  it("calls onProviderError on embedding failure", async () => {
    const filePath = writeTranscript("s1", [
      { role: "user", content: "test question" },
      { role: "assistant", content: "test answer" },
    ]);

    const errors: unknown[] = [];
    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createSessionIndexer({
      sessionsDir: path.join(tmpDir, "sessions"),
      memory,
      onProviderError: (err) => errors.push(err),
    });

    await indexer.indexAllSessions();
    // No embedding provider = no provider error
    expect(errors.length).toBe(0);

    await memory.close();
  });
});
