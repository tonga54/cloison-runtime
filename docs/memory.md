# Memory System

Each workspace has its own SQLite database. Memories never cross workspace boundaries — not by access control, **by physical separation**.

## Basic Usage

```typescript
await workspace.memory.store("Project uses React and TypeScript");
await workspace.memory.store("Deploy every Friday at 3pm via CI/CD");

const results = await workspace.memory.search("what framework do we use?");
// → "React and TypeScript"
```

## Autonomous Agent Memory

The agent decides what to remember. Memory persists across sessions, across restarts.

```typescript
// Session 1
await runtime.run({
  message: "My name is Juan, I work in fintech, I prefer TypeScript",
  sessionId: "onboarding",
});

// Session 2 — different session, memory persists
await runtime.run({
  message: "Set up a new project for me",
  sessionId: "new-project",
});
// Agent searches memory -> finds preferences -> scaffolds TypeScript project
```

## Hybrid Search Engine

| Stage | Algorithm |
|-------|-----------|
| **Vector search** | Cosine similarity against stored embeddings |
| **Keyword search** | SQLite FTS5 with BM25 ranking |
| **Fusion** | Weighted merge of vector + keyword scores |
| **Temporal decay** | Exponential time-based score attenuation |
| **Diversity** | MMR (Maximal Marginal Relevance) re-ranking |
| **Query expansion** | 7-language keyword extraction (EN/ES/PT/ZH/JA/KO/AR) |

Works without any embedding API key — falls back to FTS5 keyword search.

## Embedding Providers

Optional — keyword search works without any API key.

| Provider | Default Model | Local |
|----------|--------------|-------|
| **OpenAI** | `text-embedding-3-small` | |
| **Gemini** | `gemini-embedding-001` | |
| **Voyage** | `voyage-3-lite` | |
| **Mistral** | `mistral-embed` | |
| **Ollama** | `nomic-embed-text` | **Yes** |

## Embedding Cache

Embeddings are cached in SQLite to avoid re-embedding unchanged content. Enabled by default.

```typescript
const memory = createSimpleMemoryManager({
  dbDir: "/var/data/memory",
  embeddingProvider: createEmbeddingProvider({ provider: "openai", apiKey: "..." }),
  enableEmbeddingCache: true,
  maxCacheEntries: 50_000,
});
```

## Batch Embedding with Retry

```typescript
import { embedBatchWithRetry } from "bulkhead-runtime";

const result = await embedBatchWithRetry(
  ["text 1", "text 2", "text 3"],
  {
    provider: embeddingProvider,
    cache: memory.embeddingCache ?? undefined,
    batchSize: 100,
    concurrency: 2,
    retryAttempts: 3,
  },
);
// result: { embeddings: [...], cached: 150, computed: 50, errors: 0 }
```

## File-based Memory Indexing

Automatically watches `MEMORY.md` and `memory/` directory for changes and re-indexes them.

```typescript
import { createFileIndexer } from "bulkhead-runtime";

const indexer = createFileIndexer({
  workspaceDir: "/path/to/workspace",
  memory,
  watchPaths: ["docs/"],
  debounceMs: 2000,
});

indexer.start();
indexer.stop();
```

## Session Transcript Indexing

Indexes session transcripts into memory for cross-session search. Supports post-compaction re-indexing.

```typescript
import { createSessionIndexer } from "bulkhead-runtime";

const indexer = createSessionIndexer({
  sessionsDir: path.join(stateDir, "sessions"),
  memory,
  deltaBytes: 4096,
  deltaMessages: 10,
});

await indexer.indexAllSessions();
indexer.onTranscriptUpdate(sessionFile);
```

## SSRF Protection

All embedding provider HTTP calls are protected against Server-Side Request Forgery. The SSRF engine resolves DNS and pins IPs before connecting, blocks private/link-local ranges, and enforces a hostname allowlist. Fail-closed by default.

```typescript
import { validateUrl } from "bulkhead-runtime";

await validateUrl("https://api.openai.com/v1/embeddings"); // OK
await validateUrl("http://169.254.1.1/steal");              // throws SSRF error
```

## Source Files

- `src/memory/hybrid.ts` — Vector + FTS5 fusion scoring
- `src/memory/mmr.ts` — Maximal Marginal Relevance re-ranking
- `src/memory/temporal-decay.ts` — Exponential time-based scoring
- `src/memory/query-expansion.ts` — 7-language keyword expansion
- `src/memory/embedding-cache.ts` — SQLite embedding cache
- `src/memory/embedding-batch.ts` — Batch embedding with retry
- `src/memory/file-indexer.ts` — File-based memory indexing
- `src/memory/session-indexer.ts` — Session transcript indexing
- `src/memory/ssrf.ts` — SSRF protection for HTTP calls
