import { describe, it, expect } from "vitest";
import {
  shouldRunMemoryFlush,
  createMemoryFlushState,
  markMemoryFlushed,
  estimateSessionTokens,
  MEMORY_FLUSH_PROMPT,
  MEMORY_FLUSH_SYSTEM_PROMPT,
} from "../src/runtime/memory-flush.js";

describe("shouldRunMemoryFlush", () => {
  it("returns false when under threshold", () => {
    const state = createMemoryFlushState();
    expect(shouldRunMemoryFlush({
      estimatedTokens: 5000,
      contextWindowTokens: 128000,
      sessionId: "s1",
      state,
    })).toBe(false);
  });

  it("returns true when over threshold", () => {
    const state = createMemoryFlushState();
    expect(shouldRunMemoryFlush({
      estimatedTokens: 100000,
      contextWindowTokens: 128000,
      sessionId: "s1",
      state,
    })).toBe(true);
  });

  it("returns false if already flushed for session", () => {
    const state = createMemoryFlushState();
    markMemoryFlushed(state, "s1");
    expect(shouldRunMemoryFlush({
      estimatedTokens: 100000,
      contextWindowTokens: 128000,
      sessionId: "s1",
      state,
    })).toBe(false);
  });

  it("respects custom threshold ratio", () => {
    const state = createMemoryFlushState();
    expect(shouldRunMemoryFlush({
      estimatedTokens: 50000,
      contextWindowTokens: 128000,
      thresholdRatio: 0.3,
      sessionId: "s1",
      state,
    })).toBe(true);
  });
});

describe("createMemoryFlushState", () => {
  it("starts empty", () => {
    const state = createMemoryFlushState();
    expect(state.flushedSessionIds.size).toBe(0);
  });
});

describe("markMemoryFlushed", () => {
  it("marks session as flushed", () => {
    const state = createMemoryFlushState();
    markMemoryFlushed(state, "s1");
    expect(state.flushedSessionIds.has("s1")).toBe(true);
  });
});

describe("estimateSessionTokens", () => {
  it("estimates string content", () => {
    const tokens = estimateSessionTokens([
      { role: "user", content: "a".repeat(400) },
    ]);
    expect(tokens).toBe(Math.ceil(400 / 4) + 4);
  });

  it("estimates array content", () => {
    const tokens = estimateSessionTokens([
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("constants", () => {
  it("MEMORY_FLUSH_PROMPT exists and mentions memory_store", () => {
    expect(MEMORY_FLUSH_PROMPT).toContain("memory_store");
  });

  it("MEMORY_FLUSH_SYSTEM_PROMPT exists", () => {
    expect(MEMORY_FLUSH_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
