// Ported from OpenClaw src/agents/pi-embedded-runner/tool-result-truncation.ts
// Truncates oversized tool results in session files and in-memory messages
// as a fallback when compaction cannot reduce context enough.

import * as fs from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("tool-result-truncation");

const CHARS_PER_TOKEN = 4;
const MAX_TOOL_RESULT_CHARS_CAP = 400_000;
const CONTEXT_WINDOW_TOOL_RESULT_RATIO = 0.3;
const HEAD_RATIO = 0.15;
const TAIL_RATIO = 0.05;
const TRUNCATION_MARKER = "\n\n[… tool output truncated to fit context window …]\n\n";

export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const maxChars = Math.floor(contextWindowTokens * CHARS_PER_TOKEN * CONTEXT_WINDOW_TOOL_RESULT_RATIO);
  return Math.min(maxChars, MAX_TOOL_RESULT_CHARS_CAP);
}

export function truncateToolResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.max(200, Math.floor(maxChars * HEAD_RATIO));
  const tailChars = Math.max(100, Math.floor(maxChars * TAIL_RATIO));
  const available = maxChars - TRUNCATION_MARKER.length;
  if (available <= 0) return text.slice(0, maxChars);
  const head = Math.min(headChars, Math.floor(available * 0.75));
  const tail = Math.min(tailChars, available - head);
  return text.slice(0, head) + TRUNCATION_MARKER + text.slice(-tail);
}

interface AgentMessage {
  role: string;
  content?: unknown;
}

export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): boolean {
  const maxChars = calculateMaxToolResultChars(params.contextWindowTokens);
  for (const msg of params.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result" && block.type !== "tool_use_result") continue;
      const text = typeof block.content === "string" ? block.content : null;
      if (text && text.length > maxChars) return true;
    }
  }
  return false;
}

export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  contextWindowTokens: number,
): { messages: AgentMessage[]; truncatedCount: number } {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let modified = false;
    const newContent = (msg.content as Array<Record<string, unknown>>).map((block) => {
      if (block.type !== "tool_result" && block.type !== "tool_use_result") return block;
      const text = typeof block.content === "string" ? block.content : null;
      if (!text || text.length <= maxChars) return block;
      modified = true;
      truncatedCount++;
      return { ...block, content: truncateToolResultText(text, maxChars) };
    });
    return modified ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, truncatedCount };
}

export async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ truncated: boolean; truncatedCount: number }> {
  const maxChars = calculateMaxToolResultChars(params.contextWindowTokens);

  try {
    const raw = fs.readFileSync(params.sessionFile, "utf-8");
    const lines = raw.split("\n");
    let totalTruncated = 0;
    let modified = false;

    const newLines = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const msg = JSON.parse(line) as AgentMessage;
        if (!Array.isArray(msg.content)) return line;

        let lineModified = false;
        const newContent = (msg.content as Array<Record<string, unknown>>).map((block) => {
          if (block.type !== "tool_result" && block.type !== "tool_use_result") return block;
          const text = typeof block.content === "string" ? block.content : null;
          if (!text || text.length <= maxChars) return block;
          lineModified = true;
          totalTruncated++;
          return { ...block, content: truncateToolResultText(text, maxChars) };
        });

        if (lineModified) {
          modified = true;
          return JSON.stringify({ ...msg, content: newContent });
        }
        return line;
      } catch {
        return line;
      }
    });

    if (modified) {
      fs.writeFileSync(params.sessionFile, newLines.join("\n"));
      log.info("truncated oversized tool results in session", {
        sessionFile: params.sessionFile,
        truncatedCount: totalTruncated,
        maxChars,
      });
    }

    return { truncated: modified, truncatedCount: totalTruncated };
  } catch (err) {
    log.warn("failed to truncate tool results in session", { error: String(err) });
    return { truncated: false, truncatedCount: 0 };
  }
}
