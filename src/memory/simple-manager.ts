import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "./sqlite.js";
import { cosineSimilarity, parseEmbedding, chunkMarkdown, hashText } from "./internal.js";
import { extractKeywords } from "./query-expansion.js";
import { buildFtsQuery, bm25RankToScore, mergeHybridResults } from "./hybrid.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { MemorySearchResult } from "./types.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import { createEmbeddingCache, hashContent, type EmbeddingCache } from "./embedding-cache.js";

const SNIPPET_MAX_CHARS = 700;
const MAX_VECTOR_SEARCH_CHUNKS = 10_000;

export interface SimpleMemoryManager {
  store(content: string, metadata?: Record<string, unknown>): Promise<string>;
  search(query: string, options?: { maxResults?: number; minScore?: number }): Promise<MemorySearchResult[]>;
  delete(id: string): Promise<boolean>;
  list(): Promise<Array<{ id: string; content: string; metadata?: Record<string, unknown>; createdAt: string }>>;
  close(): Promise<void>;
  readonly db: DatabaseSync;
  readonly embeddingCache: EmbeddingCache | null;
}

export interface SimpleMemoryManagerOptions {
  dbDir: string;
  embeddingProvider?: EmbeddingProvider;
  enableEmbeddingCache?: boolean;
  maxCacheEntries?: number;
}

function generateId(): string {
  return `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

export function createSimpleMemoryManager(options: SimpleMemoryManagerOptions): SimpleMemoryManager {
  fs.mkdirSync(options.dbDir, { recursive: true });
  const dbPath = path.join(options.dbDir, "memory.db");
  const { DatabaseSync } = requireNodeSqlite();
  const db: DatabaseSync = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  // Schema matches OpenClaw's MemoryIndexManager
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding TEXT,
      metadata TEXT,
      source TEXT DEFAULT 'memory',
      path TEXT,
      model TEXT,
      start_line INTEGER DEFAULT 1,
      end_line INTEGER DEFAULT 1,
      hash TEXT,
      created_at TEXT NOT NULL
    )
  `);

  let ftsAvailable = false;
  let stmtFtsInsert: ReturnType<typeof db.prepare> | null = null;
  let stmtFtsDelete: ReturnType<typeof db.prepare> | null = null;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(id, content, source, model)
    `);
    stmtFtsInsert = db.prepare("INSERT INTO chunks_fts(id, content, source, model) VALUES (?, ?, ?, ?)");
    stmtFtsDelete = db.prepare("DELETE FROM chunks_fts WHERE id = ?");
    ftsAvailable = true;
  } catch {
    // FTS5 not available
  }

  const provider = options.embeddingProvider ?? null;
  const providerModel = provider ? `${provider.id}/${provider.model}` : "none";

  const embeddingCache = (options.enableEmbeddingCache !== false && provider)
    ? createEmbeddingCache(db)
    : null;
  const maxCacheEntries = options.maxCacheEntries ?? 50_000;

  const stmtInsert = db.prepare(`
    INSERT OR REPLACE INTO chunks (id, content, embedding, metadata, source, path, model, start_line, end_line, hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtDelete = db.prepare("DELETE FROM chunks WHERE id = ?");
  const stmtListAll = db.prepare("SELECT id, content, metadata, created_at FROM chunks ORDER BY created_at DESC");
  const stmtGet = db.prepare("SELECT * FROM chunks WHERE id = ?");

  return {
    async store(content, metadata) {
      const id = generateId();
      const now = new Date().toISOString();
      const hash = hashText(content);

      let embeddingJson: string | null = null;
      if (provider) {
        try {
          const contentHash = hashContent(content);
          const cached = embeddingCache?.get(provider.id, provider.model, contentHash);
          let vec: number[];
          if (cached) {
            vec = cached;
            debugEmbeddingsLog("embedding from cache", { id, dims: vec.length });
          } else {
            vec = await provider.embedQuery(content);
            embeddingCache?.set(provider.id, provider.model, "", contentHash, vec, vec.length);
            debugEmbeddingsLog("embedded chunk", { id, dims: vec.length });
          }
          embeddingJson = JSON.stringify(vec);
        } catch (err) {
          debugEmbeddingsLog("embedding failed", { id, error: String(err) });
        }
      }

      stmtInsert.run(
        id, content, embeddingJson,
        metadata ? JSON.stringify(metadata) : null,
        "memory", null, providerModel,
        1, 1, hash, now,
      );

      if (stmtFtsInsert) {
        try {
          stmtFtsInsert.run(id, content, "memory", providerModel);
        } catch {
          // FTS insert failed, keyword search won't find this chunk
        }
      }

      return id;
    },

    async search(query, opts) {
      const maxResults = opts?.maxResults ?? 10;
      const minScore = opts?.minScore ?? 0;
      const candidateLimit = Math.max(1, maxResults * 3);

      // Vector search
      let vectorResults: Array<{ id: string; path: string; startLine: number; endLine: number; source: string; snippet: string; vectorScore: number }> = [];
      if (provider) {
        try {
          const queryVec = await provider.embedQuery(query);
          const rows = db.prepare(
            "SELECT * FROM chunks WHERE embedding IS NOT NULL AND model = ? LIMIT ?",
          ).all(providerModel, MAX_VECTOR_SEARCH_CHUNKS) as Array<Record<string, unknown>>;

          const scored: Array<{ row: Record<string, unknown>; score: number }> = [];
          for (const row of rows) {
            const embedding = parseEmbedding(row.embedding as string);
            if (embedding.length === 0) continue;
            const score = cosineSimilarity(queryVec, embedding);
            if (Number.isFinite(score)) scored.push({ row, score });
          }
          scored.sort((a, b) => b.score - a.score);

          vectorResults = scored.slice(0, candidateLimit).map(({ row, score }) => ({
            id: row.id as string,
            path: (row.path as string) ?? "",
            startLine: (row.start_line as number) ?? 1,
            endLine: (row.end_line as number) ?? 1,
            source: (row.source as string) ?? "memory",
            snippet: ((row.content as string) ?? "").slice(0, SNIPPET_MAX_CHARS),
            vectorScore: score,
          }));
        } catch {
          // Vector search failed
        }
      }

      // Keyword search using OpenClaw's query expansion
      let keywordResults: Array<{ id: string; path: string; startLine: number; endLine: number; source: string; snippet: string; textScore: number }> = [];

      if (ftsAvailable) {
        const keywords = extractKeywords(query);
        const searchTerms = keywords.length > 0 ? keywords : [query];

        for (const term of searchTerms) {
          const ftsQuery = buildFtsQuery(term);
          if (!ftsQuery) continue;
          try {
            const rows = db.prepare(
              `SELECT id, content, source, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank ASC LIMIT ?`,
            ).all(ftsQuery, candidateLimit) as Array<{ id: string; content: string; source: string; rank: number }>;

            for (const row of rows) {
              keywordResults.push({
                id: row.id,
                path: "",
                startLine: 1,
                endLine: 1,
                source: row.source ?? "memory",
                snippet: row.content.slice(0, SNIPPET_MAX_CHARS),
                textScore: bm25RankToScore(row.rank),
              });
            }
          } catch {
            // FTS query failed
          }
        }

        // Deduplicate keyword results
        const byId = new Map<string, (typeof keywordResults)[0]>();
        for (const r of keywordResults) {
          const existing = byId.get(r.id);
          if (!existing || r.textScore > existing.textScore) byId.set(r.id, r);
        }
        keywordResults = Array.from(byId.values());
      }

      // Merge using OpenClaw's hybrid merge
      const merged = await mergeHybridResults({
        vector: vectorResults,
        keyword: keywordResults,
        vectorWeight: provider ? 0.7 : 0,
        textWeight: provider ? 0.3 : 1,
      });

      return merged
        .filter((r) => r.score >= minScore)
        .slice(0, maxResults) as MemorySearchResult[];
    },

    async delete(id) {
      const row = stmtGet.get(id) as Record<string, unknown> | undefined;
      if (!row) return false;
      stmtDelete.run(id);
      if (stmtFtsDelete) {
        try {
          stmtFtsDelete.run(id);
        } catch {}
      }
      return true;
    },

    async list() {
      const rows = stmtListAll.all() as Array<{ id: string; content: string; metadata: string | null; created_at: string }>;
      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
        createdAt: r.created_at,
      }));
    },

    async close() {
      if (embeddingCache) {
        embeddingCache.prune(maxCacheEntries);
      }
      db.close();
    },

    get db() { return db; },
    get embeddingCache() { return embeddingCache; },
  };
}
