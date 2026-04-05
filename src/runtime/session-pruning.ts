// Ported from OpenClaw src/agents/pi-hooks/context-pruning/pruner.ts
// Trims old tool results in-memory before sending to the model.
// Soft-trim: head+tail truncation. Hard-clear: replace with placeholder.

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("session-pruning");

const CHARS_PER_TOKEN = 4;
const DEFAULT_SOFT_TRIM_RATIO = 0.7;
const DEFAULT_HARD_CLEAR_RATIO = 0.85;
const MIN_RESULT_CHARS_TO_PRUNE = 2000;
const TRUNCATION_MARKER = "\n\n[… content trimmed to fit context window …]\n";
const CLEAR_PLACEHOLDER = "[tool output cleared to fit context window]";
const HEAD_RATIO = 0.3;
const TAIL_RATIO = 0.7;

export interface SessionPruningOptions {
  contextWindowTokens: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
}

export interface PruneResult {
  pruned: boolean;
  softTrimmed: number;
  hardCleared: number;
  originalTokens: number;
  prunedTokens: number;
}

interface AgentMessage {
  role: string;
  content?: unknown;
}

function estimateMessageTokens(msg: AgentMessage): number {
  if (!msg.content) return 4;
  if (typeof msg.content === "string") return Math.ceil(msg.content.length / CHARS_PER_TOKEN) + 4;
  if (Array.isArray(msg.content)) {
    let total = 4;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        total += Math.ceil((block.text as string).length / CHARS_PER_TOKEN);
      } else if (block.type === "tool_result" && typeof block.content === "string") {
        total += Math.ceil((block.content as string).length / CHARS_PER_TOKEN);
      } else {
        total += 50;
      }
    }
    return total;
  }
  return Math.ceil(JSON.stringify(msg.content).length / CHARS_PER_TOKEN) + 4;
}

function estimateTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  return total;
}

function isToolResultBlock(block: Record<string, unknown>): boolean {
  return block.type === "tool_result" || block.type === "tool_use_result";
}

function getToolResultText(block: Record<string, unknown>): string | null {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    const textParts = (block.content as Array<Record<string, unknown>>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string);
    return textParts.length > 0 ? textParts.join("\n") : null;
  }
  return null;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = Math.floor(maxChars * TAIL_RATIO);
  return text.slice(0, headChars) + TRUNCATION_MARKER + text.slice(-tailChars);
}

export function pruneContextMessages(
  messages: AgentMessage[],
  options: SessionPruningOptions,
): { messages: AgentMessage[]; result: PruneResult } {
  const { contextWindowTokens } = options;
  const softTrimRatio = options.softTrimRatio ?? DEFAULT_SOFT_TRIM_RATIO;
  const hardClearRatio = options.hardClearRatio ?? DEFAULT_HARD_CLEAR_RATIO;

  const originalTokens = estimateTotalTokens(messages);
  const softThreshold = contextWindowTokens * softTrimRatio;
  const hardThreshold = contextWindowTokens * hardClearRatio;

  if (originalTokens <= softThreshold) {
    return {
      messages,
      result: { pruned: false, softTrimmed: 0, hardCleared: 0, originalTokens, prunedTokens: originalTokens },
    };
  }

  let softTrimmed = 0;
  let hardCleared = 0;
  const recentBoundary = Math.max(0, messages.length - 6);
  const prunedMessages: AgentMessage[] = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];

    if (msg.role === "system" || msg.role === "user" || msgIdx >= recentBoundary || !Array.isArray(msg.content)) {
      prunedMessages.push(msg);
      continue;
    }

    const needsHardClear = originalTokens > hardThreshold;

    const newContent = (msg.content as Array<Record<string, unknown>>).map((block) => {
      if (!isToolResultBlock(block)) return block;
      const text = getToolResultText(block);
      if (!text || text.length < MIN_RESULT_CHARS_TO_PRUNE) return block;

      if (needsHardClear) {
        hardCleared++;
        return { ...block, content: CLEAR_PLACEHOLDER };
      }

      const maxChars = Math.max(500, Math.floor(text.length * 0.3));
      softTrimmed++;
      return { ...block, content: truncateText(text, maxChars) };
    });

    prunedMessages.push({ ...msg, content: newContent });
  }

  const prunedTokens = estimateTotalTokens(prunedMessages);

  if (softTrimmed > 0 || hardCleared > 0) {
    log.info("pruned context messages", {
      originalTokens,
      prunedTokens,
      softTrimmed,
      hardCleared,
      saved: originalTokens - prunedTokens,
    });
  }

  return {
    messages: prunedMessages,
    result: { pruned: softTrimmed > 0 || hardCleared > 0, softTrimmed, hardCleared, originalTokens, prunedTokens },
  };
}
