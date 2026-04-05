/**
 * Demo: Failover error classification system
 *
 * Shows:
 * - How errors from LLM providers are classified into failover reasons
 * - HTTP status code classification (401, 402, 429, 503, etc.)
 * - Message-based classification (rate limit, billing, auth, timeout, context overflow)
 * - Provider-specific patterns (Bedrock, Groq, Azure, Ollama)
 * - 402 disambiguation (billing vs rate_limit)
 * - Context overflow detection and exclusions
 *
 * Run: npx tsx demos/demo-error-classification.ts
 * Note: No API key needed — this demo runs entirely locally.
 */
import {
  classifyFailoverSignal,
  coerceToFailoverError,
  describeFailoverError,
  isLikelyContextOverflowError,
  isRateLimitErrorMessage,
  isBillingErrorMessage,
  isTimeoutErrorMessage,
  isModelNotFoundErrorMessage,
  FailoverError,
  type FailoverSignal,
} from "../src/runtime/failover-error.js";

function classify(label: string, signal: FailoverSignal) {
  const result = classifyFailoverSignal(signal);
  const reason = result?.kind === "reason" ? result.reason : result?.kind ?? "unclassified";
  const tag = reason.padEnd(20);
  console.log(`  ${tag} ← ${label}`);
}

function main() {
  console.log("=== Failover Error Classification Demo ===\n");

  // --- HTTP status classification ---
  console.log("--- By HTTP status code ---\n");
  classify("401 Unauthorized", { status: 401 });
  classify("402 Payment Required", { status: 402 });
  classify("403 Forbidden", { status: 403 });
  classify("404 Not Found", { status: 404, message: "model not found" });
  classify("408 Request Timeout", { status: 408 });
  classify("429 Too Many Requests", { status: 429 });
  classify("500 Internal Server Error", { status: 500 });
  classify("503 Service Unavailable", { status: 503 });
  classify("529 Overloaded", { status: 529 });

  // --- Message-based classification ---
  console.log("\n--- By error message ---\n");
  classify("Rate limit exceeded", { message: "rate limit exceeded" });
  classify("Resource exhausted", { message: "resource has been exhausted" });
  classify("Tokens per day limit", { message: "tokens per day limit reached" });
  classify("Credit balance too low", { message: "credit balance is too low" });
  classify("Invalid API key", { message: "invalid_api_key: key sk-... is revoked" });
  classify("Model not found", { message: "the model does not exist" });
  classify("Socket hang up", { message: "socket hang up" });
  classify("Fetch failed", { message: "fetch failed: ECONNRESET" });
  classify("Context length exceeded", { message: "context length exceeded" });
  classify("Prompt too long", { message: "prompt is too long for model" });

  // --- Provider-specific patterns ---
  console.log("\n--- Provider-specific patterns ---\n");
  classify("AWS Bedrock throttling", { message: "ThrottlingException: Too many requests" });
  classify("Bedrock model not ready", { message: "ModelNotReadyException: model loading" });
  classify("Bedrock context overflow", { message: "ValidationException: input is too long for the model" });
  classify("Groq model deactivated", { message: "model_is_deactivated" });
  classify("Ollama context overflow", { message: "ollama: context length exceeded for llama3" });
  classify("Vertex INVALID_ARGUMENT", { message: "INVALID_ARGUMENT: input too large for model" });
  classify("Concurrency limit", { message: "concurrency limit has been reached" });

  // --- 402 disambiguation ---
  console.log("\n--- 402 disambiguation (billing vs rate_limit) ---\n");
  classify("402 + insufficient credits", { status: 402, message: "insufficient credits, please add more" });
  classify("402 + daily limit reset", { status: 402, message: "daily usage limit exceeded, try again later" });
  classify("402 + quota refresh", { status: 402, message: "subscription quota limit - automatic quota refresh in 24h" });
  classify("402 + upgrade plan", { status: 402, message: "upgrade your plan to increase limit" });
  classify("402 + org spend limit", { status: 402, message: "organization monthly spend limit reached, billing period resets soon" });

  // --- Context overflow exclusions ---
  console.log("\n--- Context overflow vs false positives ---\n");
  const overflowTests = [
    { msg: "context length exceeded", expected: true },
    { msg: "429 rate limit: too many requests per minute", expected: false },
    { msg: "402 payment required, please upgrade plan", expected: false },
    { msg: "413 TPM limit exceeded", expected: false },
    { msg: "reasoning is mandatory for this model", expected: false },
    { msg: "context_window_exceeded", expected: true },
    { msg: "上下文过长", expected: true },
  ];
  for (const { msg, expected } of overflowTests) {
    const result = isLikelyContextOverflowError(msg);
    const status = result === expected ? "✓" : "✗";
    console.log(`  ${status} "${msg.slice(0, 50)}..." → ${result} (expected: ${expected})`);
  }

  // --- coerceToFailoverError ---
  console.log("\n--- Error coercion ---\n");
  const rawError = new Error("429 Too Many Requests: rate limit exceeded");
  const coerced = coerceToFailoverError(rawError, { provider: "openai", model: "gpt-4o" });
  if (coerced) {
    console.log(`  Raw error  → FailoverError(reason=${coerced.reason}, provider=${coerced.provider}, status=${coerced.status})`);
  }

  const unclassifiable = new Error("something weird happened");
  const notCoerced = coerceToFailoverError(unclassifiable);
  console.log(`  Unknown error → ${notCoerced === null ? "null (not classifiable)" : "coerced"}`);

  // --- describeFailoverError ---
  console.log("\n--- Error description ---\n");
  const described = describeFailoverError(
    new FailoverError("Service Unavailable", { reason: "overloaded", provider: "anthropic", status: 503 }),
  );
  console.log(`  message: "${described.message}"`);
  console.log(`  reason:  ${described.reason}`);
  console.log(`  status:  ${described.status}`);

  console.log("\nDemo complete.");
}

main();
