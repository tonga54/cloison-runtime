import { describe, it, expect } from "vitest";
import {
  FailoverError,
  isFailoverError,
  coerceToFailoverError,
  describeFailoverError,
  resolveFailoverReasonFromError,
  isLikelyContextOverflowError,
  isContextOverflowError,
  isTimeoutError,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
  isBillingErrorMessage,
  isAuthPermanentErrorMessage,
  isModelNotFoundErrorMessage,
  classifyFailoverSignal,
} from "../src/runtime/failover-error.js";

describe("FailoverError", () => {
  it("creates with reason and provider info", () => {
    const err = new FailoverError("rate limited", {
      reason: "rate_limit",
      provider: "openai",
      model: "gpt-4o",
      status: 429,
    });
    expect(err.name).toBe("FailoverError");
    expect(err.reason).toBe("rate_limit");
    expect(err.provider).toBe("openai");
    expect(err.status).toBe(429);
    expect(isFailoverError(err)).toBe(true);
  });
});

describe("coerceToFailoverError", () => {
  it("converts rate limit error", () => {
    const err = new Error("429 Too Many Requests");
    const failover = coerceToFailoverError(err, { provider: "openai", model: "gpt-4o" });
    expect(failover).not.toBeNull();
    expect(failover!.reason).toBe("rate_limit");
  });

  it("converts timeout error", () => {
    const err = new Error("request timed out");
    const failover = coerceToFailoverError(err);
    expect(failover).not.toBeNull();
    expect(failover!.reason).toBe("timeout");
  });

  it("returns null for unclassifiable errors", () => {
    const err = new Error("something random happened");
    expect(coerceToFailoverError(err)).toBeNull();
  });

  it("preserves existing FailoverError", () => {
    const original = new FailoverError("test", { reason: "billing" });
    expect(coerceToFailoverError(original)).toBe(original);
  });
});

describe("describeFailoverError", () => {
  it("describes FailoverError", () => {
    const err = new FailoverError("overloaded", { reason: "overloaded", status: 503 });
    const desc = describeFailoverError(err);
    expect(desc.reason).toBe("overloaded");
    expect(desc.status).toBe(503);
  });

  it("describes plain error", () => {
    const err = new Error("503 Service Unavailable");
    const desc = describeFailoverError(err);
    expect(desc.message).toBe("503 Service Unavailable");
  });
});

describe("classifyFailoverSignal", () => {
  it("classifies by HTTP status", () => {
    expect(classifyFailoverSignal({ status: 429 })).toEqual({ kind: "reason", reason: "rate_limit" });
    expect(classifyFailoverSignal({ status: 402 })).toEqual({ kind: "reason", reason: "billing" });
    expect(classifyFailoverSignal({ status: 401 })).toEqual({ kind: "reason", reason: "auth" });
    expect(classifyFailoverSignal({ status: 503 })).toEqual({ kind: "reason", reason: "timeout" });
    expect(classifyFailoverSignal({ status: 500 })).toEqual({ kind: "reason", reason: "timeout" });
  });

  it("classifies by error code", () => {
    expect(classifyFailoverSignal({ code: "RATE_LIMIT" })).toEqual({ kind: "reason", reason: "rate_limit" });
    expect(classifyFailoverSignal({ code: "ECONNRESET" })).toEqual({ kind: "reason", reason: "timeout" });
    expect(classifyFailoverSignal({ code: "OVERLOADED" })).toEqual({ kind: "reason", reason: "overloaded" });
  });

  it("classifies by message", () => {
    expect(classifyFailoverSignal({ message: "rate limit exceeded" })).toEqual({ kind: "reason", reason: "rate_limit" });
    expect(classifyFailoverSignal({ message: "context length exceeded" })).toEqual({ kind: "context_overflow" });
    expect(classifyFailoverSignal({ message: "model not found" })).toEqual({ kind: "reason", reason: "model_not_found" });
  });

  it("returns null for unknown", () => {
    expect(classifyFailoverSignal({ message: "something random" })).toBeNull();
  });
});

describe("isLikelyContextOverflowError", () => {
  it("detects context overflow", () => {
    expect(isLikelyContextOverflowError("context length exceeded")).toBe(true);
    expect(isLikelyContextOverflowError("prompt is too long")).toBe(true);
    expect(isLikelyContextOverflowError("context_window_exceeded")).toBe(true);
    expect(isLikelyContextOverflowError("exceeds model context window")).toBe(true);
  });

  it("excludes rate limits", () => {
    expect(isLikelyContextOverflowError("429 rate limit exceeded")).toBe(false);
    expect(isLikelyContextOverflowError("too many requests")).toBe(false);
  });

  it("excludes billing errors", () => {
    expect(isLikelyContextOverflowError("402 payment required")).toBe(false);
  });

  it("excludes TPM limits (Groq 413)", () => {
    expect(isLikelyContextOverflowError("413 TPM limit exceeded")).toBe(false);
  });
});

describe("provider-specific classification", () => {
  it("detects Bedrock ThrottlingException", () => {
    expect(classifyFailoverSignal({ message: "ThrottlingException: Too many requests" }))
      .toEqual({ kind: "reason", reason: "rate_limit" });
  });

  it("detects Groq model_deactivated", () => {
    expect(classifyFailoverSignal({ message: "model_is_deactivated" }))
      .toEqual({ kind: "reason", reason: "model_not_found" });
  });

  it("detects session expired", () => {
    expect(classifyFailoverSignal({ message: "session not found" }))
      .toEqual({ kind: "reason", reason: "session_expired" });
    expect(classifyFailoverSignal({ message: "conversation expired" }))
      .toEqual({ kind: "reason", reason: "session_expired" });
  });

  it("detects periodic usage limits as rate_limit", () => {
    expect(classifyFailoverSignal({ message: "daily usage limit reached" }))
      .toEqual({ kind: "reason", reason: "rate_limit" });
  });

  it("image dimension errors are not classified", () => {
    expect(classifyFailoverSignal({ message: "image dimensions exceed max allowed size for many-image requests: 1024 pixels" }))
      .toBeNull();
  });

  it("provider context overflow patterns", () => {
    expect(classifyFailoverSignal({ message: "ValidationException: input is too long for model" }))
      .toEqual({ kind: "context_overflow" });
    expect(classifyFailoverSignal({ message: "ollama: context length exceeded" }))
      .toEqual({ kind: "context_overflow" });
  });
});

describe("402 classification", () => {
  it("classifies quota refresh window as rate_limit", () => {
    expect(classifyFailoverSignal({ status: 402, message: "subscription quota limit - automatic quota refresh in 24h" }))
      .toEqual({ kind: "reason", reason: "rate_limit" });
  });

  it("classifies insufficient credits as billing", () => {
    expect(classifyFailoverSignal({ status: 402, message: "insufficient credits" }))
      .toEqual({ kind: "reason", reason: "billing" });
  });

  it("classifies daily spend limit as rate_limit", () => {
    expect(classifyFailoverSignal({ message: "402 organization daily usage limit exceeded, try again later" }))
      .toEqual({ kind: "reason", reason: "rate_limit" });
  });
});

describe("error message matchers", () => {
  it("isRateLimitErrorMessage", () => {
    expect(isRateLimitErrorMessage("rate limit exceeded")).toBe(true);
    expect(isRateLimitErrorMessage("429 Too Many Requests")).toBe(true);
    expect(isRateLimitErrorMessage("resource has been exhausted")).toBe(true);
    expect(isRateLimitErrorMessage("tokens per day limit")).toBe(true);
    expect(isRateLimitErrorMessage("model not found")).toBe(false);
  });

  it("isTimeoutErrorMessage", () => {
    expect(isTimeoutErrorMessage("request timed out")).toBe(true);
    expect(isTimeoutErrorMessage("socket hang up")).toBe(true);
    expect(isTimeoutErrorMessage("fetch failed")).toBe(true);
    expect(isTimeoutErrorMessage("ECONNRESET")).toBe(true);
    expect(isTimeoutErrorMessage("invalid api key")).toBe(false);
  });

  it("isBillingErrorMessage", () => {
    expect(isBillingErrorMessage("payment required")).toBe(true);
    expect(isBillingErrorMessage("insufficient credits")).toBe(true);
    expect(isBillingErrorMessage("credit balance is too low")).toBe(true);
    expect(isBillingErrorMessage("model not found")).toBe(false);
  });

  it("isAuthPermanentErrorMessage", () => {
    expect(isAuthPermanentErrorMessage("invalid_api_key")).toBe(true);
    expect(isAuthPermanentErrorMessage("key has been revoked")).toBe(true);
    expect(isAuthPermanentErrorMessage("permission_error")).toBe(true);
  });

  it("isModelNotFoundErrorMessage", () => {
    expect(isModelNotFoundErrorMessage("model_not_found")).toBe(true);
    expect(isModelNotFoundErrorMessage("the model does not exist")).toBe(true);
  });
});

describe("isTimeoutError", () => {
  it("detects TimeoutError by name", () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    expect(isTimeoutError(err)).toBe(true);
  });

  it("detects AbortError with timeout cause", () => {
    const cause = new Error("timed out");
    cause.name = "TimeoutError";
    const err = new Error("aborted");
    err.name = "AbortError";
    (err as Error & { cause: unknown }).cause = cause;
    expect(isTimeoutError(err)).toBe(true);
  });

  it("non-timeout AbortError is not timeout", () => {
    const err = new Error("user cancelled");
    err.name = "AbortError";
    expect(isTimeoutError(err)).toBe(false);
  });
});
