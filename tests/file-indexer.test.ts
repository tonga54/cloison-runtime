import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFileIndexer } from "../src/memory/file-indexer.js";
import { createSimpleMemoryManager } from "../src/memory/simple-manager.js";

describe("FileIndexer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-idx-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes MEMORY.md on sync", async () => {
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Project Notes\n\nThis project uses TypeScript.\n");
    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createFileIndexer({ workspaceDir: tmpDir, memory });

    const result = await indexer.sync();
    expect(result.filesProcessed).toBeGreaterThanOrEqual(1);
    expect(result.chunksStored).toBeGreaterThan(0);
    expect(result.errors).toBe(0);

    await memory.close();
  });

  it("indexes files in memory/ directory", async () => {
    const memDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memDir);
    fs.writeFileSync(path.join(memDir, "notes.md"), "# API Design\n\nREST endpoints use JSON.\n");
    fs.writeFileSync(path.join(memDir, "stack.md"), "# Stack\n\nNode.js + TypeScript.\n");

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createFileIndexer({ workspaceDir: tmpDir, memory });

    const result = await indexer.sync();
    expect(result.filesProcessed).toBe(2);
    expect(result.chunksStored).toBeGreaterThanOrEqual(2);

    await memory.close();
  });

  it("skips unchanged files on re-sync", async () => {
    fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Notes\n\nSome content.\n");
    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createFileIndexer({ workspaceDir: tmpDir, memory });

    const first = await indexer.sync();
    expect(first.chunksStored).toBeGreaterThan(0);

    const second = await indexer.sync();
    expect(second.chunksStored).toBe(0);
    expect(second.chunksRemoved).toBe(0);

    await memory.close();
  });

  it("re-indexes changed files", async () => {
    const memPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memPath, "# V1\n\nOriginal content.\n");

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createFileIndexer({ workspaceDir: tmpDir, memory });

    await indexer.sync();

    fs.writeFileSync(memPath, "# V2\n\nUpdated content.\n");
    const result = await indexer.sync();
    expect(result.chunksRemoved).toBeGreaterThan(0);
    expect(result.chunksStored).toBeGreaterThan(0);

    await memory.close();
  });

  it("removes chunks when file is deleted", async () => {
    const memPath = path.join(tmpDir, "MEMORY.md");
    fs.writeFileSync(memPath, "# Notes\n\nSome content.\n");

    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createFileIndexer({ workspaceDir: tmpDir, memory });

    await indexer.sync();
    fs.unlinkSync(memPath);

    const result = await indexer.sync();
    expect(result.chunksRemoved).toBeGreaterThan(0);

    await memory.close();
  });

  it("starts and stops watcher", () => {
    const memory = createSimpleMemoryManager({ dbDir: path.join(tmpDir, "db") });
    const indexer = createFileIndexer({ workspaceDir: tmpDir, memory });

    expect(indexer.watching).toBe(false);
    indexer.start();
    expect(indexer.watching).toBe(true);
    indexer.stop();
    expect(indexer.watching).toBe(false);

    memory.close();
  });
});
