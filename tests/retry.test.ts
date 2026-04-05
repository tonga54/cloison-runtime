import { describe, it, expect } from "vitest";
import { retryAsync, resolveRetryConfig, isRetryableError } from "../src/runtime/retry.js";
import { isLikelyContextOverflowError, isRateLimitErrorMessage } from "../src/runtime/failover-error.js";

describe("retryAsync (number overload)", () => {
  it("returns result on first success", async () => {
    const result = await retryAsync(async () => 42);
    expect(result).toBe(42);
  });

  it("retries on failure and succeeds", async () => {
    let attempts = 0;
    const result = await retryAsync(
      async () => { attempts++; if (attempts < 3) throw new Error("fail"); return "ok"; },
      3, 1,
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("throws after exhausting attempts", async () => {
    await expect(
      retryAsync(async () => { throw new Error("always fails"); }, 2, 1),
    ).rejects.toThrow("always fails");
  });
});

describe("retryAsync (options overload)", () => {
  it("respects shouldRetry predicate", async () => {
    let attempts = 0;
    await expect(
      retryAsync(
        async () => { attempts++; throw new Error("non-retryable"); },
        { attempts: 5, minDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow("non-retryable");
    expect(attempts).toBe(1);
  });

  it("calls onRetry callback", async () => {
    const retries: number[] = [];
    let attempts = 0;
    await retryAsync(
      async () => { attempts++; if (attempts < 3) throw new Error("fail"); return "ok"; },
      { attempts: 3, minDelayMs: 1, onRetry: ({ attempt }) => retries.push(attempt) },
    );
    expect(retries).toEqual([1, 2]);
  });

  it("supports retryAfterMs callback", async () => {
    let attempts = 0;
    const start = Date.now();
    await retryAsync(
      async () => { attempts++; if (attempts < 2) throw new Error("fail"); return "ok"; },
      {
        attempts: 3,
        minDelayMs: 1,
        maxDelayMs: 100,
        retryAfterMs: () => 10,
      },
    );
    expect(attempts).toBe(2);
  });
});

describe("resolveRetryConfig", () => {
  it("uses defaults", () => {
    const config = resolveRetryConfig();
    expect(config.attempts).toBe(3);
    expect(config.minDelayMs).toBe(300);
    expect(config.maxDelayMs).toBe(30_000);
    expect(config.jitter).toBe(0);
  });

  it("clamps negative values", () => {
    const config = resolveRetryConfig(undefined, { attempts: -1, minDelayMs: -100 });
    expect(config.attempts).toBe(1);
    expect(config.minDelayMs).toBe(0);
  });
});

describe("isRetryableError", () => {
  it("matches common transient errors", () => {
    expect(isRetryableError("429 Too Many Requests")).toBe(true);
    expect(isRetryableError("500 Internal Server Error")).toBe(true);
    expect(isRetryableError("socket hang up")).toBe(true);
    expect(isRetryableError("fetch failed")).toBe(true);
  });
});

describe("isRateLimitErrorMessage (from failover-error)", () => {
  it("matches rate limit patterns", () => {
    expect(isRateLimitErrorMessage("rate limit exceeded")).toBe(true);
    expect(isRateLimitErrorMessage("429")).toBe(true);
    expect(isRateLimitErrorMessage("resource has been exhausted")).toBe(true);
  });
});

describe("isLikelyContextOverflowError (from failover-error)", () => {
  it("matches context overflow messages", () => {
    expect(isLikelyContextOverflowError("context length exceeded")).toBe(true);
    expect(isLikelyContextOverflowError("prompt is too long")).toBe(true);
    expect(isLikelyContextOverflowError("context_window_exceeded")).toBe(true);
  });

  it("does not match rate limit as overflow", () => {
    expect(isLikelyContextOverflowError("429 rate limit")).toBe(false);
    expect(isLikelyContextOverflowError("too many requests")).toBe(false);
  });

  it("does not match billing as overflow", () => {
    expect(isLikelyContextOverflowError("payment required, please upgrade plan")).toBe(false);
  });
});
