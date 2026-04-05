import { describe, it, expect } from "vitest";
import {
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
  estimateTokens,
  estimateMessagesTokens,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
} from "../src/runtime/context-guard.js";

describe("resolveContextWindowInfo", () => {
  it("uses model context window", () => {
    const info = resolveContextWindowInfo({ modelContextWindow: 32000 });
    expect(info.tokens).toBe(32000);
    expect(info.source).toBe("model");
  });

  it("caps with config when smaller than model", () => {
    const info = resolveContextWindowInfo({
      modelContextWindow: 128000,
      configContextTokens: 16000,
    });
    expect(info.tokens).toBe(16000);
    expect(info.source).toBe("agentContextTokens");
  });

  it("uses model when config is larger", () => {
    const info = resolveContextWindowInfo({
      modelContextWindow: 8000,
      configContextTokens: 128000,
    });
    expect(info.tokens).toBe(8000);
    expect(info.source).toBe("model");
  });

  it("uses default when no model context window", () => {
    const info = resolveContextWindowInfo({});
    expect(info.tokens).toBe(128000);
    expect(info.source).toBe("default");
  });

  it("uses custom default", () => {
    const info = resolveContextWindowInfo({ defaultTokens: 64000 });
    expect(info.tokens).toBe(64000);
  });

  it("uses modelsProviderConfig override", () => {
    const info = resolveContextWindowInfo({
      modelContextWindow: 128000,
      modelsProviderConfig: [{ id: "gpt-4o", contextWindow: 50000 }],
      modelId: "gpt-4o",
    });
    expect(info.tokens).toBe(50000);
    expect(info.source).toBe("modelsConfig");
  });
});

describe("evaluateContextWindowGuard", () => {
  it("passes for normal context window", () => {
    const result = evaluateContextWindowGuard({
      info: { tokens: 128000, source: "model" },
    });
    expect(result.shouldWarn).toBe(false);
    expect(result.shouldBlock).toBe(false);
  });

  it("warns for small context window (below 32K)", () => {
    const result = evaluateContextWindowGuard({
      info: { tokens: 20000, source: "model" },
    });
    expect(result.shouldWarn).toBe(true);
    expect(result.shouldBlock).toBe(false);
  });

  it("blocks for too-small context window (below 16K)", () => {
    const result = evaluateContextWindowGuard({
      info: { tokens: 8000, source: "model" },
    });
    expect(result.shouldBlock).toBe(true);
  });

  it("uses custom thresholds", () => {
    const result = evaluateContextWindowGuard({
      info: { tokens: 20000, source: "model" },
      warnBelowTokens: 10000,
      hardMinTokens: 5000,
    });
    expect(result.shouldWarn).toBe(false);
    expect(result.shouldBlock).toBe(false);
  });

  it("OpenClaw thresholds: 16K hard min, 32K warn", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(32_000);
  });
});

describe("estimateTokens", () => {
  it("approximates 4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("estimateMessagesTokens", () => {
  it("sums message tokens with overhead", () => {
    const tokens = estimateMessagesTokens([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(Math.ceil(5 / 4) + 4 + Math.ceil(2 / 4) + 4);
  });
});
