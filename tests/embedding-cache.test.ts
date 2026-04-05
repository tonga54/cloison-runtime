import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { requireNodeSqlite } from "../src/memory/sqlite.js";
import { createEmbeddingCache, hashContent } from "../src/memory/embedding-cache.js";

describe("EmbeddingCache", () => {
  let tmpDir: string;
  let db: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(path.join(tmpDir, "test.db"));
  });

  afterEach(() => {
    try { db.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves embeddings via loadBatch", () => {
    const cache = createEmbeddingCache(db);
    const hash = hashContent("hello world");
    const embedding = [0.1, 0.2, 0.3];

    cache.set("openai", "text-embedding-3-small", "pk1", hash, embedding, 3);
    const result = cache.loadBatch("openai", "text-embedding-3-small", "pk1", [hash]);

    expect(result.get(hash)).toEqual(embedding);
  });

  it("returns empty map for missing entries", () => {
    const cache = createEmbeddingCache(db);
    const result = cache.loadBatch("openai", "model", "pk", ["nonexistent"]);
    expect(result.size).toBe(0);
  });

  it("separates by provider and model", () => {
    const cache = createEmbeddingCache(db);
    const hash = hashContent("test");

    cache.set("openai", "model-a", "pk", hash, [1, 2], 2);
    cache.set("openai", "model-b", "pk", hash, [3, 4], 2);

    const a = cache.loadBatch("openai", "model-a", "pk", [hash]);
    const b = cache.loadBatch("openai", "model-b", "pk", [hash]);
    expect(a.get(hash)).toEqual([1, 2]);
    expect(b.get(hash)).toEqual([3, 4]);
  });

  it("overwrites on same key", () => {
    const cache = createEmbeddingCache(db);
    const hash = hashContent("test");

    cache.set("openai", "m", "pk", hash, [1, 2], 2);
    cache.set("openai", "m", "pk", hash, [5, 6], 2);

    const result = cache.loadBatch("openai", "m", "pk", [hash]);
    expect(result.get(hash)).toEqual([5, 6]);
  });

  it("counts entries", () => {
    const cache = createEmbeddingCache(db);
    expect(cache.count()).toBe(0);

    cache.set("a", "m", "pk", "h1", [1], 1);
    cache.set("a", "m", "pk", "h2", [2], 1);
    expect(cache.count()).toBe(2);
  });

  it("prunes oldest entries", () => {
    const cache = createEmbeddingCache(db);

    cache.set("a", "m", "pk", "h1", [1], 1);
    cache.set("a", "m", "pk", "h2", [2], 1);
    cache.set("a", "m", "pk", "h3", [3], 1);

    const pruned = cache.prune(2);
    expect(pruned).toBe(1);
    expect(cache.count()).toBe(2);
  });

  it("prune is a no-op when under limit", () => {
    const cache = createEmbeddingCache(db);
    cache.set("a", "m", "pk", "h1", [1], 1);
    const pruned = cache.prune(10);
    expect(pruned).toBe(0);
  });

  it("batch upsert works", () => {
    const cache = createEmbeddingCache(db);
    cache.upsertBatch("openai", "model", "pk", [
      { hash: "h1", embedding: [1, 2] },
      { hash: "h2", embedding: [3, 4] },
    ]);
    expect(cache.count()).toBe(2);
    const result = cache.loadBatch("openai", "model", "pk", ["h1", "h2"]);
    expect(result.get("h1")).toEqual([1, 2]);
    expect(result.get("h2")).toEqual([3, 4]);
  });
});

describe("hashContent", () => {
  it("produces consistent SHA-256 hex", () => {
    const a = hashContent("hello");
    const b = hashContent("hello");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("produces different hashes for different content", () => {
    expect(hashContent("foo")).not.toBe(hashContent("bar"));
  });
});
