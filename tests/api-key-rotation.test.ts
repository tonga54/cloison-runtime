import { describe, it, expect, afterEach } from "vitest";
import {
  executeWithApiKeyRotation,
  collectProviderApiKeys,
  isApiKeyRateLimitError,
  collectProviderApiKeysForExecution,
} from "../src/runtime/api-key-rotation.js";

describe("executeWithApiKeyRotation", () => {
  it("succeeds with first key", async () => {
    const result = await executeWithApiKeyRotation({
      provider: "openai",
      apiKeys: ["key-a", "key-b"],
      execute: async (key) => `used:${key}`,
    });
    expect(result).toBe("used:key-a");
  });

  it("rotates to second key on rate limit", async () => {
    let attempt = 0;
    const result = await executeWithApiKeyRotation({
      provider: "openai",
      apiKeys: ["key-a", "key-b"],
      execute: async (key) => {
        attempt++;
        if (attempt === 1) throw new Error("429 Too Many Requests");
        return `used:${key}`;
      },
    });
    expect(result).toBe("used:key-b");
  });

  it("throws when all keys fail", async () => {
    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-a", "key-b"],
        execute: async () => { throw new Error("429 rate limit"); },
      }),
    ).rejects.toThrow("429 rate limit");
  });

  it("throws on non-retryable error without trying next key", async () => {
    let attempts = 0;
    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-a", "key-b"],
        execute: async () => { attempts++; throw new Error("invalid API key format"); },
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("deduplicates keys", async () => {
    const usedKeys: string[] = [];
    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-a", "key-a", "key-b"],
        execute: async (key) => { usedKeys.push(key); throw new Error("429 rate limit"); },
      }),
    ).rejects.toThrow();
    expect(usedKeys).toEqual(["key-a", "key-b"]);
  });

  it("throws on empty keys", async () => {
    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: [],
        execute: async () => "ok",
      }),
    ).rejects.toThrow("No API keys configured");
  });

  it("supports custom shouldRetry", async () => {
    let attempts = 0;
    const result = await executeWithApiKeyRotation({
      provider: "openai",
      apiKeys: ["key-a", "key-b"],
      execute: async (key) => { attempts++; if (attempts === 1) throw new Error("custom-error"); return `used:${key}`; },
      shouldRetry: ({ message }) => message.includes("custom-error"),
    });
    expect(result).toBe("used:key-b");
  });
});

describe("isApiKeyRateLimitError", () => {
  it("matches rate limit patterns", () => {
    expect(isApiKeyRateLimitError("rate_limit exceeded")).toBe(true);
    expect(isApiKeyRateLimitError("429 Too Many Requests")).toBe(true);
    expect(isApiKeyRateLimitError("quota exceeded")).toBe(true);
    expect(isApiKeyRateLimitError("resource exhausted")).toBe(true);
    expect(isApiKeyRateLimitError("too many requests")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isApiKeyRateLimitError("model not found")).toBe(false);
  });
});

describe("collectProviderApiKeys", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("collects primary key", () => {
    process.env["OPENAI_API_KEY"] = "pk-1";
    const keys = collectProviderApiKeys("openai");
    expect(keys).toContain("pk-1");
  });

  it("collects comma-separated list", () => {
    process.env["OPENAI_API_KEYS"] = "k1,k2,k3";
    const keys = collectProviderApiKeys("openai");
    expect(keys).toEqual(expect.arrayContaining(["k1", "k2", "k3"]));
  });

  it("collects numbered/prefixed keys", () => {
    process.env["OPENAI_API_KEY_1"] = "g1";
    process.env["OPENAI_API_KEY_2"] = "g2";
    const keys = collectProviderApiKeys("openai");
    expect(keys).toEqual(expect.arrayContaining(["g1", "g2"]));
  });

  it("deduplicates", () => {
    process.env["ANTHROPIC_API_KEY"] = "same";
    process.env["ANTHROPIC_API_KEY_1"] = "same";
    const keys = collectProviderApiKeys("anthropic");
    expect(keys.filter((k) => k === "same")).toHaveLength(1);
  });

  it("collectProviderApiKeysForExecution merges primary", () => {
    process.env["OPENAI_API_KEY"] = "env-key";
    const keys = collectProviderApiKeysForExecution({ provider: "openai", primaryApiKey: "explicit-key" });
    expect(keys[0]).toBe("explicit-key");
    expect(keys).toContain("env-key");
  });
});
