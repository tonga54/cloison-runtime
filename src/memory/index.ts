export type {
  MemorySource,
  MemorySearchResult,
  MemorySearchManager,
  MemoryEmbeddingProbeResult,
  MemorySyncProgressUpdate,
  MemoryProviderStatus,
} from "./types.js";

export type { EmbeddingProvider } from "./embeddings.js";

export {
  cosineSimilarity,
  chunkMarkdown,
  listMemoryFiles,
  hashText,
  buildFileEntry,
  isMemoryPath,
  parseEmbedding,
  type MemoryFileEntry,
  type MemoryChunk,
} from "./internal.js";

export { searchVector, searchKeyword } from "./manager-search.js";
export { mergeHybridResults } from "./hybrid.js";
export { mmrRerank, applyMMRToHybridResults } from "./mmr.js";
export {
  applyTemporalDecayToHybridResults,
  applyTemporalDecayToScore,
  calculateTemporalDecayMultiplier,
} from "./temporal-decay.js";
export { extractKeywords } from "./query-expansion.js";
export { buildFtsQuery, bm25RankToScore } from "./hybrid.js";
export { requireNodeSqlite } from "./sqlite.js";

export { createSimpleMemoryManager, type SimpleMemoryManager } from "./simple-manager.js";

export {
  createEmbeddingCache,
  hashContent,
  type EmbeddingCache,
} from "./embedding-cache.js";

export {
  embedBatchWithCacheAndRetry,
  embedQueryWithTimeout,
  runBatchWithFallback,
  createBatchFailureState,
  enforceEmbeddingMaxInputTokens,
  type BatchEmbeddingOptions,
  type BatchEmbeddingResult,
  type BatchFailureState,
} from "./embedding-batch.js";

export {
  createFileIndexer,
  type FileIndexer,
  type FileIndexerOptions,
  type FileIndexSyncResult,
} from "./file-indexer.js";

export {
  createSessionIndexer,
  type SessionIndexer,
  type SessionIndexerOptions,
  type SessionIndexResult,
} from "./session-indexer.js";

export {
  buildBaseUrlPolicy,
  validateUrl,
  fetchWithSsrfGuard,
  type SsrfPolicy,
} from "./ssrf.js";
