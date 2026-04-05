// Ported from OpenClaw extensions/memory-core/src/memory/manager-embedding-ops.ts
// All constants, retry logic, batch failure tracking, and timeout resolution are identical.

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { EmbeddingCache } from "./embedding-cache.js";
import { hashContent } from "./embedding-cache.js";

const log = createSubsystemLogger("embedding-batch");

// Constants from OpenClaw
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const BATCH_FAILURE_LIMIT = 2;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;
const APPROX_CHARS_PER_TOKEN = 4;

export interface BatchEmbeddingOptions {
  provider: EmbeddingProvider;
  cache?: EmbeddingCache;
  providerKey?: string;
  concurrency?: number;
}

export interface BatchEmbeddingResult {
  embeddings: Array<number[] | null>;
  cached: number;
  computed: number;
  errors: number;
}

interface ChunkItem {
  originalIndex: number;
  text: string;
  hash: string;
}

// --- Batch failure tracking (from OpenClaw) ---

export interface BatchFailureState {
  count: number;
  lastError?: string;
  lastProvider?: string;
  enabled: boolean;
}

export function createBatchFailureState(): BatchFailureState {
  return { count: 0, enabled: true };
}

function recordBatchFailure(state: BatchFailureState, params: {
  provider: string;
  message: string;
  attempts?: number;
  forceDisable?: boolean;
}): { disabled: boolean; count: number } {
  if (!state.enabled) return { disabled: true, count: state.count };
  const increment = params.forceDisable ? BATCH_FAILURE_LIMIT : Math.max(1, params.attempts ?? 1);
  state.count += increment;
  state.lastError = params.message;
  state.lastProvider = params.provider;
  const disabled = params.forceDisable || state.count >= BATCH_FAILURE_LIMIT;
  if (disabled) state.enabled = false;
  return { disabled, count: state.count };
}

function resetBatchFailureCount(state: BatchFailureState): void {
  if (state.count > 0) {
    log.debug("embedding batch recovered; resetting failure count");
  }
  state.count = 0;
  state.lastError = undefined;
  state.lastProvider = undefined;
}

// --- Timeout helper (from OpenClaw) ---

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return (await Promise.race([promise, timeoutPromise])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveEmbeddingTimeout(provider: EmbeddingProvider, kind: "query" | "batch"): number {
  const isLocal = provider.id === "ollama" || provider.id === "local";
  if (kind === "query") return isLocal ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
  return isLocal ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
}

// --- Retry logic (from OpenClaw) ---

function isRetryableEmbeddingError(message: string): boolean {
  return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare|tokens per day)/i.test(message);
}

function isBatchTimeoutError(message: string): boolean {
  return /timed out|timeout/i.test(message);
}

async function waitForEmbeddingRetry(delayMs: number, action: string): Promise<void> {
  const waitMs = Math.min(EMBEDDING_RETRY_MAX_DELAY_MS, Math.round(delayMs * (1 + Math.random() * 0.2)));
  log.warn(`memory embeddings rate limited; ${action} in ${waitMs}ms`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function embedBatchWithRetry(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  let attempt = 0;
  let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
  while (true) {
    try {
      const timeoutMs = resolveEmbeddingTimeout(provider, "batch");
      log.debug("embedding batch start", { provider: provider.id, items: texts.length, timeoutMs });
      return await withTimeout(
        provider.embedBatch(texts),
        timeoutMs,
        `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) throw err;
      await waitForEmbeddingRetry(delayMs, "retrying");
      delayMs *= 2;
      attempt += 1;
    }
  }
}

export async function embedQueryWithTimeout(provider: EmbeddingProvider, text: string): Promise<number[]> {
  const timeoutMs = resolveEmbeddingTimeout(provider, "query");
  log.debug("embedding query start", { provider: provider.id, timeoutMs });
  return await withTimeout(
    provider.embedQuery(text),
    timeoutMs,
    `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

// --- Batch splitting (from OpenClaw buildEmbeddingBatches) ---

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function buildEmbeddingBatches(items: ChunkItem[]): ChunkItem[][] {
  const batches: ChunkItem[][] = [];
  let current: ChunkItem[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const estimate = estimateTokens(item.text);
    const wouldExceed = current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS;
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
      batches.push([item]);
      continue;
    }
    current.push(item);
    currentTokens += estimate;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

// --- collectCachedEmbeddings (from OpenClaw) ---

function collectCachedEmbeddings(
  items: ChunkItem[],
  cache: EmbeddingCache | undefined,
  provider: EmbeddingProvider,
  providerKey: string,
): { embeddings: Array<number[] | null>; missing: ChunkItem[] } {
  const embeddings: Array<number[] | null> = new Array(items.length).fill(null);
  const missing: ChunkItem[] = [];

  if (!cache) {
    return { embeddings, missing: [...items] };
  }

  const cached = cache.loadBatch(provider.id, provider.model, providerKey, items.map((i) => i.hash));

  for (let i = 0; i < items.length; i++) {
    const hit = items[i].hash ? cached.get(items[i].hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    } else {
      missing.push(items[i]);
    }
  }

  return { embeddings, missing };
}

// --- Main batch embedding function ---

export async function embedBatchWithCacheAndRetry(
  texts: string[],
  options: BatchEmbeddingOptions,
): Promise<BatchEmbeddingResult> {
  const { provider, cache, providerKey = "", concurrency = EMBEDDING_INDEX_CONCURRENCY } = options;

  const items: ChunkItem[] = texts.map((text, i) => ({
    originalIndex: i,
    text,
    hash: hashContent(text),
  }));

  const { embeddings: resultEmbeddings, missing } = collectCachedEmbeddings(items, cache, provider, providerKey);
  const results: Array<number[] | null> = [...resultEmbeddings];
  let cached = items.length - missing.length;
  let computed = 0;
  let errors = 0;

  if (missing.length === 0) {
    log.debug(`all ${texts.length} embeddings served from cache`);
    return { embeddings: results, cached, computed, errors };
  }

  const batches = buildEmbeddingBatches(missing);
  log.debug(`processing ${missing.length} uncached texts in ${batches.length} batches (${cached} cached)`);

  const toCache: Array<{ hash: string; embedding: number[] }> = [];

  for (let g = 0; g < batches.length; g += concurrency) {
    const group = batches.slice(g, g + concurrency);
    await Promise.all(
      group.map(async (batch) => {
        const batchTexts = batch.map((item) => item.text);
        try {
          const batchEmbeddings = await embedBatchWithRetry(provider, batchTexts);
          for (let j = 0; j < batch.length; j++) {
            const embedding = batchEmbeddings[j] ?? [];
            if (embedding.length > 0) {
              results[batch[j].originalIndex] = embedding;
              computed++;
              toCache.push({ hash: batch[j].hash, embedding });
            } else {
              errors++;
            }
          }
        } catch (err) {
          log.error(`batch embedding failed`, { batchSize: batch.length, error: String(err) });
          errors += batch.length;
        }
      }),
    );
  }

  if (cache && toCache.length > 0) {
    cache.upsertBatch(provider.id, provider.model, providerKey, toCache);
  }

  log.info("batch complete", { total: texts.length, cached, computed, errors });
  return { embeddings: results, cached, computed, errors };
}

// --- Batch with fallback (from OpenClaw runBatchWithFallback) ---

export async function runBatchWithTimeoutRetry<T>(params: {
  provider: string;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await params.run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isBatchTimeoutError(message)) {
      log.warn(`${params.provider} batch timed out; retrying once`);
      try {
        return await params.run();
      } catch (retryErr) {
        (retryErr as { batchAttempts?: number }).batchAttempts = 2;
        throw retryErr;
      }
    }
    throw err;
  }
}

export async function runBatchWithFallback<T>(params: {
  state: BatchFailureState;
  provider: string;
  run: () => Promise<T>;
  fallback: () => Promise<number[][]>;
}): Promise<T | number[][]> {
  if (!params.state.enabled) return await params.fallback();
  try {
    const result = await runBatchWithTimeoutRetry({ provider: params.provider, run: params.run });
    resetBatchFailureCount(params.state);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = (err as { batchAttempts?: number }).batchAttempts ?? 1;
    const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
    const failure = recordBatchFailure(params.state, { provider: params.provider, message, attempts, forceDisable });
    const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
    log.warn(`${params.provider} batch failed (${failure.count}/${BATCH_FAILURE_LIMIT}); ${suffix}; falling back: ${message}`);
    return await params.fallback();
  }
}

// --- enforceEmbeddingMaxInputTokens (from OpenClaw) ---

export function enforceEmbeddingMaxInputTokens(
  provider: EmbeddingProvider,
  texts: string[],
  maxBatchTokens: number = EMBEDDING_BATCH_MAX_TOKENS,
): string[] {
  const maxTokens = provider.maxInputTokens;
  if (!maxTokens || maxTokens <= 0) return texts;

  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  return texts.map((text) => {
    if (text.length <= maxChars) return text;
    log.debug("truncating text to fit max input tokens", {
      originalLength: text.length,
      maxChars,
      maxTokens,
    });
    return text.slice(0, maxChars);
  });
}

export { EMBEDDING_BATCH_MAX_TOKENS, EMBEDDING_INDEX_CONCURRENCY };
