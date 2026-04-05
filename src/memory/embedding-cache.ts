// Ported from OpenClaw extensions/memory-core/src/memory/manager-embedding-ops.ts
// Cache operations: loadEmbeddingCache, upsertEmbeddingCache, collectCachedEmbeddings, pruneEmbeddingCacheIfNeeded

import * as crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseEmbedding } from "./internal.js";

const log = createSubsystemLogger("embedding-cache");

const EMBEDDING_CACHE_TABLE = "embedding_cache";
const CACHE_BATCH_SIZE = 400;

export interface EmbeddingCache {
  get(provider: string, model: string, contentHash: string): number[] | null;
  loadBatch(provider: string, model: string, providerKey: string, hashes: string[]): Map<string, number[]>;
  set(provider: string, model: string, providerKey: string, contentHash: string, embedding: number[], dims: number): void;
  upsertBatch(provider: string, model: string, providerKey: string, entries: Array<{ hash: string; embedding: number[] }>): void;
  prune(maxEntries: number): number;
  count(): number;
}

export function createEmbeddingCacheTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EMBEDDING_CACHE_TABLE} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${EMBEDDING_CACHE_TABLE}(updated_at)`,
  );
}

export function createEmbeddingCache(db: DatabaseSync): EmbeddingCache {
  createEmbeddingCacheTable(db);

  const stmtGet = db.prepare(
    `SELECT embedding FROM ${EMBEDDING_CACHE_TABLE} WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`,
  );
  const stmtCount = db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`);
  const stmtPrune = db.prepare(
    `DELETE FROM ${EMBEDDING_CACHE_TABLE} WHERE rowid IN (SELECT rowid FROM ${EMBEDDING_CACHE_TABLE} ORDER BY updated_at ASC LIMIT ?)`,
  );

  return {
    // Simple single-item get (backwards compat)
    get(provider, model, contentHash) {
      try {
        const row = stmtGet.get(provider, model, "", contentHash) as { embedding: string } | undefined;
        if (!row) return null;
        return parseEmbedding(row.embedding);
      } catch {
        return null;
      }
    },

    // Batch lookup (OpenClaw's loadEmbeddingCache with 400-item SQL batching)
    loadBatch(provider, model, providerKey, hashes) {
      const out = new Map<string, number[]>();
      if (hashes.length === 0) return out;

      const unique: string[] = [];
      const seen = new Set<string>();
      for (const hash of hashes) {
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        unique.push(hash);
      }
      if (unique.length === 0) return out;

      const baseParams = [provider, model, providerKey];
      for (let start = 0; start < unique.length; start += CACHE_BATCH_SIZE) {
        const batch = unique.slice(start, start + CACHE_BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(", ");
        try {
          const rows = db.prepare(
            `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE} WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
          ).all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;
          for (const row of rows) {
            out.set(row.hash, parseEmbedding(row.embedding));
          }
        } catch {
          // continue with partial results
        }
      }
      return out;
    },

    // Single-item insert
    set(provider, model, providerKey, contentHash, embedding, dims) {
      try {
        db.prepare(
          `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET embedding=excluded.embedding, dims=excluded.dims, updated_at=excluded.updated_at`,
        ).run(provider, model, providerKey, contentHash, JSON.stringify(embedding), dims, Date.now());
      } catch (err) {
        log.warn("cache write failed", { error: String(err) });
      }
    },

    // Bulk upsert (OpenClaw's upsertEmbeddingCache)
    upsertBatch(provider, model, providerKey, entries) {
      if (entries.length === 0) return;
      const now = Date.now();
      const stmt = db.prepare(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET embedding=excluded.embedding, dims=excluded.dims, updated_at=excluded.updated_at`,
      );
      for (const entry of entries) {
        const embedding = entry.embedding ?? [];
        stmt.run(provider, model, providerKey, entry.hash, JSON.stringify(embedding), embedding.length, now);
      }
    },

    // LRU pruning (OpenClaw's pruneEmbeddingCacheIfNeeded)
    prune(maxEntries) {
      if (maxEntries <= 0) return 0;
      const row = stmtCount.get() as { c: number } | undefined;
      const count = row?.c ?? 0;
      if (count <= maxEntries) return 0;
      const excess = count - maxEntries;
      stmtPrune.run(excess);
      return excess;
    },

    count() {
      return (stmtCount.get() as { c: number }).c;
    },
  };
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
