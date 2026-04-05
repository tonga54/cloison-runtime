import { describe, it, expect, beforeEach } from "vitest";
import {
  runWithModelFallback,
  resolveFallbackCandidates,
  parseFallbackRef,
  FallbackSummaryError,
  isFallbackSummaryError,
  clearCooldowns,
} from "../src/runtime/model-fallback.js";

describe("parseFallbackRef", () => {
  it("parses provider/model format", () => {
    expect(parseFallbackRef("google/gemini-2.5-flash", "openai")).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
    });
  });

  it("uses default provider for bare model", () => {
    expect(parseFallbackRef("gpt-4o", "openai")).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("handles model with slashes", () => {
    expect(parseFallbackRef("anthropic/claude-3/opus", "openai")).toEqual({
      provider: "anthropic",
      model: "claude-3/opus",
    });
  });
});

describe("resolveFallbackCandidates", () => {
  it("returns primary as first candidate", () => {
    const candidates = resolveFallbackCandidates("anthropic", "claude-sonnet-4-20250514");
    expect(candidates[0]).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
  });

  it("adds fallbacks in order", () => {
    const candidates = resolveFallbackCandidates("anthropic", "claude-sonnet-4-20250514", [
      "openai/gpt-4o",
      "google/gemini-2.5-flash",
    ]);
    expect(candidates).toHaveLength(3);
    expect(candidates[1].provider).toBe("openai");
    expect(candidates[2].provider).toBe("google");
  });

  it("deduplicates primary with fallbacks", () => {
    const candidates = resolveFallbackCandidates("openai", "gpt-4o", [
      "openai/gpt-4o",
      "google/gemini-2.5-flash",
    ]);
    expect(candidates).toHaveLength(2);
  });

  it("handles empty fallbacks", () => {
    const candidates = resolveFallbackCandidates("openai", "gpt-4o", []);
    expect(candidates).toHaveLength(1);
  });
});

describe("runWithModelFallback", () => {
  beforeEach(() => {
    clearCooldowns();
  });
  it("succeeds with primary model", async () => {
    const result = await runWithModelFallback({
      provider: "openai",
      model: "gpt-4o",
      run: async (provider, model) => `${provider}/${model}`,
    });

    expect(result.result).toBe("openai/gpt-4o");
    expect(result.attempts).toHaveLength(0);
  });

  it("falls back on primary failure", async () => {
    let attempt = 0;
    const result = await runWithModelFallback({
      provider: "openai",
      model: "gpt-4o",
      fallbacks: ["google/gemini-2.5-flash"],
      run: async (provider, model) => {
        attempt++;
        if (attempt === 1) throw new Error("503 Service Unavailable");
        return `${provider}/${model}`;
      },
    });

    expect(result.result).toBe("google/gemini-2.5-flash");
    expect(result.attempts.length).toBeGreaterThan(0);
  });

  it("throws FallbackSummaryError when all fail", async () => {
    try {
      await runWithModelFallback({
        provider: "openai",
        model: "gpt-4o",
        fallbacks: ["google/gemini-2.5-flash"],
        run: async () => { throw new Error("503 Service Unavailable"); },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isFallbackSummaryError(err)).toBe(true);
      expect((err as FallbackSummaryError).attempts).toHaveLength(2);
    }
  });

  it("does not attempt fallback on abort errors", async () => {
    let attempts = 0;
    await expect(
      runWithModelFallback({
        provider: "openai",
        model: "gpt-4o",
        fallbacks: ["google/gemini-2.5-flash"],
        run: async () => {
          attempts++;
          const err = new Error("operation cancelled");
          err.name = "AbortError";
          throw err;
        },
      }),
    ).rejects.toThrow("operation cancelled");
    expect(attempts).toBe(1);
  });

  it("skips providers in cooldown", async () => {
    const { recordProviderCooldown } = await import("../src/runtime/model-fallback.js");
    recordProviderCooldown("openai", "billing");
    
    let attempt = 0;
    const result = await runWithModelFallback({
      provider: "openai",
      model: "gpt-4o",
      fallbacks: ["google/gemini-2.5-flash"],
      run: async (provider, model) => {
        attempt++;
        return `${provider}/${model}`;
      },
    });
    
    expect(result.result).toBe("google/gemini-2.5-flash");
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.attempts[0].reason).toBe("billing");
  });

  it("includes soonestCooldownExpiry in FallbackSummaryError", async () => {
    const { recordProviderCooldown } = await import("../src/runtime/model-fallback.js");
    recordProviderCooldown("openai", "rate_limit");
    recordProviderCooldown("google", "rate_limit");
    
    try {
      await runWithModelFallback({
        provider: "openai",
        model: "gpt-4o",
        fallbacks: ["google/gemini-2.5-flash"],
        run: async () => { throw new Error("should not be called"); },
      });
      expect.unreachable();
    } catch (err) {
      expect(isFallbackSummaryError(err)).toBe(true);
      expect((err as FallbackSummaryError).soonestCooldownExpiry).not.toBeNull();
    }
  });

  it("throws immediately on context overflow (no fallback)", async () => {
    let attempts = 0;
    await expect(
      runWithModelFallback({
        provider: "openai",
        model: "gpt-4o",
        fallbacks: ["google/gemini-2.5-flash"],
        run: async () => {
          attempts++;
          throw new Error("context length exceeded");
        },
      }),
    ).rejects.toThrow("context length exceeded");
    expect(attempts).toBe(1);
  });
});
