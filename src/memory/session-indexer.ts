// Ported from OpenClaw extensions/memory-core/src/memory/manager-sync-ops.ts
// Session listener, delta tracking, debounce, countNewlines, post-compaction support

import * as fs from "node:fs";
import * as path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";
import type { SimpleMemoryManager } from "./simple-manager.js";
import {
  onSessionTranscriptUpdate,
  emitSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";

const log = createSubsystemLogger("memory/session-indexer");

// Constants from OpenClaw
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;

export type PostCompactionSyncMode = "off" | "async" | "await";

export interface MemoryIndexMeta {
  model: string;
  provider: string;
  providerKey?: string;
  chunkTokens: number;
  chunkOverlap: number;
  sources?: string[];
}

export interface SessionIndexerOptions {
  sessionsDir: string;
  memory: SimpleMemoryManager;
  deltaBytes?: number;
  deltaMessages?: number;
  postCompactionSyncMode?: PostCompactionSyncMode;
  embeddingProvider?: { id: string; model: string };
  chunking?: { tokens: number; overlap: number };
  onProviderError?: (error: unknown) => void;
}

export interface SessionIndexer {
  indexSession(sessionFile: string): Promise<SessionIndexResult>;
  indexAllSessions(): Promise<SessionIndexResult>;
  onTranscriptUpdate(sessionFile: string): void;
  startListener(): () => void;
  runPostCompactionSideEffects(sessionFile: string): Promise<void>;
}

export interface SessionIndexResult {
  sessionsProcessed: number;
  chunksStored: number;
  chunksRemoved: number;
  errors: number;
}

// Session delta tracking (from OpenClaw)
interface SessionDelta {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
}

interface SessionState {
  hash: string;
  bytesSeen: number;
  chunkIds: string[];
}

export function createSessionIndexer(options: SessionIndexerOptions): SessionIndexer {
  const {
    sessionsDir,
    memory,
    deltaBytes = 4096,
    deltaMessages = 10,
    postCompactionSyncMode = "async",
    embeddingProvider,
    chunking = { tokens: 500, overlap: 50 },
    onProviderError,
  } = options;

  let currentMeta: MemoryIndexMeta | null = null;

  function buildMeta(): MemoryIndexMeta {
    return {
      model: embeddingProvider?.model ?? "fts-only",
      provider: embeddingProvider?.id ?? "none",
      chunkTokens: chunking.tokens,
      chunkOverlap: chunking.overlap,
      sources: ["sessions"],
    };
  }

  function needsFullReindex(): boolean {
    if (!currentMeta) return true;
    const expected = buildMeta();
    return (
      currentMeta.model !== expected.model ||
      currentMeta.provider !== expected.provider ||
      currentMeta.chunkTokens !== expected.chunkTokens ||
      currentMeta.chunkOverlap !== expected.chunkOverlap
    );
  }

  const sessionStates = new Map<string, SessionState>();
  const sessionDeltas = new Map<string, SessionDelta>();
  const pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  let sessionsDirty = false;
  const sessionsDirtyFiles = new Set<string>();

  // --- countNewlines (from OpenClaw, 64KB chunk reads) ---

  async function countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) return 0;
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(absPath, "r");
    } catch {
      return 0;
    }
    try {
      let offset = start;
      let count = 0;
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) break;
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) count += 1;
        }
        offset += bytesRead;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  // --- Delta tracking (from OpenClaw updateSessionDelta) ---

  async function updateSessionDelta(sessionFile: string): Promise<{
    shouldSync: boolean;
    state: SessionDelta;
  }> {
    let stat: { size: number };
    try {
      stat = await fs.promises.stat(sessionFile);
    } catch {
      return { shouldSync: false, state: { lastSize: 0, pendingBytes: 0, pendingMessages: 0 } };
    }

    const size = stat.size;
    let state = sessionDeltas.get(sessionFile);
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      sessionDeltas.set(sessionFile, state);
    }

    const deltaB = Math.max(0, size - state.lastSize);
    if (deltaB === 0 && size === state.lastSize) {
      const bytesHit = deltaBytes <= 0 ? state.pendingBytes > 0 : state.pendingBytes >= deltaBytes;
      const messagesHit = deltaMessages <= 0 ? state.pendingMessages > 0 : state.pendingMessages >= deltaMessages;
      return { shouldSync: bytesHit || messagesHit, state };
    }

    if (size < state.lastSize) {
      state.lastSize = size;
      state.pendingBytes += size;
      const shouldCountMessages = deltaMessages > 0 && (deltaBytes <= 0 || state.pendingBytes < deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await countNewlines(sessionFile, 0, size);
      }
    } else {
      state.pendingBytes += deltaB;
      const shouldCountMessages = deltaMessages > 0 && (deltaBytes <= 0 || state.pendingBytes < deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await countNewlines(sessionFile, state.lastSize, size);
      }
      state.lastSize = size;
    }

    const bytesHit = deltaBytes <= 0 ? state.pendingBytes > 0 : state.pendingBytes >= deltaBytes;
    const messagesHit = deltaMessages <= 0 ? state.pendingMessages > 0 : state.pendingMessages >= deltaMessages;
    return { shouldSync: bytesHit || messagesHit, state };
  }

  function resetSessionDelta(absPath: string, size: number): void {
    const state = sessionDeltas.get(absPath);
    if (!state) return;
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  // --- Session file discovery ---

  function findSessionFiles(): string[] {
    const files: string[] = [];
    try {
      if (!fs.existsSync(sessionsDir)) return files;
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(sessionsDir, entry.name);
          try {
            const subEntries = fs.readdirSync(subDir);
            for (const subEntry of subEntries) {
              if (subEntry.endsWith(".jsonl")) files.push(path.join(subDir, subEntry));
            }
          } catch { /* skip */ }
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(path.join(sessionsDir, entry.name));
        }
      }
    } catch { /* sessions dir may not exist yet */ }
    return files;
  }

  // --- Transcript parsing ---

  function parseTranscript(filePath: string): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const role = String(parsed.role ?? "unknown");
          let content = "";
          if (typeof parsed.content === "string") {
            content = parsed.content;
          } else if (Array.isArray(parsed.content)) {
            content = (parsed.content as Array<Record<string, unknown>>)
              .filter((p) => p.type === "text")
              .map((p) => String(p.text ?? ""))
              .join("\n");
          }
          if (content.trim()) messages.push({ role, content });
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file not readable */ }
    return messages;
  }

  function summarizeTranscript(messages: Array<{ role: string; content: string }>): string {
    const chunks: string[] = [];
    for (const msg of messages) {
      const prefix = msg.role === "assistant" ? "Assistant" : "User";
      const truncated = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
      chunks.push(`${prefix}: ${truncated}`);
    }
    return chunks.join("\n\n");
  }

  // --- Index a single session ---

  async function indexSession(sessionFile: string): Promise<SessionIndexResult> {
    const result: SessionIndexResult = { sessionsProcessed: 0, chunksStored: 0, chunksRemoved: 0, errors: 0 };
    try {
      if (!fs.existsSync(sessionFile)) return result;
      const stat = fs.statSync(sessionFile);
      const currentHash = hashText(fs.readFileSync(sessionFile, "utf-8"));
      const existing = sessionStates.get(sessionFile);

      if (existing && existing.hash === currentHash) {
        result.sessionsProcessed++;
        resetSessionDelta(sessionFile, stat.size);
        return result;
      }

      if (existing) {
        for (const id of existing.chunkIds) {
          try { await memory.delete(id); result.chunksRemoved++; } catch { result.errors++; }
        }
      }

      const messages = parseTranscript(sessionFile);
      if (messages.length < 2) {
        result.sessionsProcessed++;
        resetSessionDelta(sessionFile, stat.size);
        return result;
      }

      const summary = summarizeTranscript(messages);
      const relPath = path.relative(path.dirname(path.dirname(sessionFile)), sessionFile);
      const CHUNK_SIZE = 2000;
      const newChunkIds: string[] = [];

      for (let i = 0; i < summary.length; i += CHUNK_SIZE) {
        const chunk = summary.slice(i, i + CHUNK_SIZE);
        try {
          const id = await memory.store(chunk, { source: "session", path: relPath, messageCount: messages.length });
          newChunkIds.push(id);
          result.chunksStored++;
        } catch { result.errors++; }
      }

      sessionStates.set(sessionFile, { hash: currentHash, bytesSeen: stat.size, chunkIds: newChunkIds });
      resetSessionDelta(sessionFile, stat.size);
      result.sessionsProcessed++;
    } catch (err) {
      log.error(`failed to index session ${sessionFile}`, { error: String(err) });
      result.errors++;
    }
    return result;
  }

  async function indexAllSessions(): Promise<SessionIndexResult> {
    if (needsFullReindex()) {
      log.info("config changed, clearing session index state and stale chunks");
      // Clear stale chunks from DB before re-indexing (prevents duplicates)
      for (const [, state] of sessionStates) {
        for (const id of state.chunkIds) {
          try { await memory.delete(id); } catch { /* best effort */ }
        }
      }
      sessionStates.clear();
      sessionDeltas.clear();
      currentMeta = buildMeta();
    }

    const totals: SessionIndexResult = { sessionsProcessed: 0, chunksStored: 0, chunksRemoved: 0, errors: 0 };
    const files = findSessionFiles();
    for (const file of files) {
      try {
        const r = await indexSession(file);
        totals.sessionsProcessed += r.sessionsProcessed;
        totals.chunksStored += r.chunksStored;
        totals.chunksRemoved += r.chunksRemoved;
        totals.errors += r.errors;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/embedding|embeddings|batch/i.test(message)) {
          log.warn(`provider error during session indexing, notifying caller: ${message}`);
          onProviderError?.(err);
        }
        totals.errors++;
      }
    }
    log.info("session indexing complete", {
      sessions: totals.sessionsProcessed,
      stored: totals.chunksStored,
      removed: totals.chunksRemoved,
      errors: totals.errors,
    });
    return totals;
  }

  // --- Debounced update (from OpenClaw scheduleSessionDirty + processSessionDeltaBatch) ---

  function onTranscriptUpdate(sessionFile: string): void {
    const existing = pendingUpdates.get(sessionFile);
    if (existing) clearTimeout(existing);

    pendingUpdates.set(
      sessionFile,
      setTimeout(async () => {
        pendingUpdates.delete(sessionFile);
        const delta = await updateSessionDelta(sessionFile);
        if (delta.shouldSync) {
          sessionsDirtyFiles.add(sessionFile);
          sessionsDirty = true;
          // Reset consumed delta
          if (deltaBytes > 0) delta.state.pendingBytes = Math.max(0, delta.state.pendingBytes - deltaBytes);
          if (deltaMessages > 0) delta.state.pendingMessages = Math.max(0, delta.state.pendingMessages - deltaMessages);
          indexSession(sessionFile).catch((err) =>
            log.error("session index update failed", { error: String(err) }),
          );
        }
      }, SESSION_DIRTY_DEBOUNCE_MS),
    );
  }

  // --- Listener (from OpenClaw ensureSessionListener) ---

  function startListener(): () => void {
    return onSessionTranscriptUpdate((update) => {
      const sessionFile = update.sessionFile;
      if (!sessionFile) return;
      const resolvedFile = path.resolve(sessionFile);
      const resolvedDir = path.resolve(sessionsDir);
      if (!resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) return;
      onTranscriptUpdate(resolvedFile);
    });
  }

  // --- Post-compaction (from OpenClaw compaction-hooks.ts) ---

  async function runPostCompactionSideEffects(sessionFile: string): Promise<void> {
    const trimmed = sessionFile.trim();
    if (!trimmed) return;

    emitSessionTranscriptUpdate(trimmed);

    if (postCompactionSyncMode === "off") return;

    const syncTask = indexSession(trimmed);
    if (postCompactionSyncMode === "await") {
      await syncTask;
    } else {
      void syncTask;
    }
  }

  return {
    indexSession,
    indexAllSessions,
    onTranscriptUpdate,
    startListener,
    runPostCompactionSideEffects,
  };
}
