// Ported from OpenClaw src/auto-reply/reply/agent-runner-memory.ts + memory-flush.ts
// Pre-compaction memory flush: runs a silent agent turn to save important
// notes to memory before compaction summarizes the conversation.

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory-flush");

const CHARS_PER_TOKEN = 4;
const DEFAULT_FLUSH_THRESHOLD_RATIO = 0.75;

export interface MemoryFlushConfig {
  enabled?: boolean;
  thresholdRatio?: number;
}

export interface MemoryFlushState {
  lastFlushCompactionCount: number;
  flushedSessionIds: Set<string>;
}

export function createMemoryFlushState(): MemoryFlushState {
  return {
    lastFlushCompactionCount: 0,
    flushedSessionIds: new Set(),
  };
}

export function shouldRunMemoryFlush(params: {
  estimatedTokens: number;
  contextWindowTokens: number;
  thresholdRatio?: number;
  sessionId: string;
  state: MemoryFlushState;
}): boolean {
  const ratio = params.thresholdRatio ?? DEFAULT_FLUSH_THRESHOLD_RATIO;
  const threshold = params.contextWindowTokens * ratio;

  if (params.estimatedTokens < threshold) return false;
  if (params.state.flushedSessionIds.has(params.sessionId)) return false;

  return true;
}

export function markMemoryFlushed(state: MemoryFlushState, sessionId: string): void {
  state.flushedSessionIds.add(sessionId);
}

export const MEMORY_FLUSH_PROMPT =
  "Before this conversation is compacted, save any important information " +
  "that hasn't been saved yet. Use memory_store to persist:\n" +
  "- Key decisions and conclusions\n" +
  "- User preferences and requirements\n" +
  "- Important facts, names, and identifiers\n" +
  "- Technical details that would be hard to reconstruct\n\n" +
  "Only save information that is NOT already in memory. Be concise. " +
  "If everything important is already saved, respond with 'Nothing new to save.'";

export const MEMORY_FLUSH_SYSTEM_PROMPT =
  "You are performing a memory flush before conversation compaction. " +
  "Your ONLY job is to review the conversation and save important unsaved information " +
  "using the memory_store tool. Do NOT respond to the user. Do NOT continue the conversation. " +
  "Just save what needs saving and stop.";

export function estimateSessionTokens(
  messages: Array<{ role: string; content?: unknown }>,
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += Math.ceil(msg.content.length / CHARS_PER_TOKEN) + 4;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (typeof block.text === "string") {
          total += Math.ceil((block.text as string).length / CHARS_PER_TOKEN);
        } else if (typeof block.content === "string") {
          total += Math.ceil((block.content as string).length / CHARS_PER_TOKEN);
        } else {
          total += 50;
        }
      }
      total += 4;
    } else {
      total += 20;
    }
  }
  return total;
}
