/**
 * Demo: Model fallback chains + API key rotation + cooldown tracking
 *
 * Shows:
 * - Automatic fallback when primary model fails
 * - Per-attempt error tracking with FallbackSummaryError
 * - Provider cooldown system (skips cooled-down providers)
 * - API key rotation on rate limit errors
 * - Context overflow short-circuits fallback (throws immediately)
 *
 * Run: npx tsx demos/demo-fallback.ts
 * Note: No API key needed — uses simulated provider responses.
 */
import {
  runWithModelFallback,
  resolveFallbackCandidates,
  FallbackSummaryError,
  isFallbackSummaryError,
  recordProviderCooldown,
  isProviderInCooldown,
  getSoonestCooldownExpiry,
  clearCooldowns,
} from "../src/runtime/model-fallback.js";
import {
  executeWithApiKeyRotation,
  collectProviderApiKeysForExecution,
} from "../src/runtime/api-key-rotation.js";

async function main() {
  console.log("=== Model Fallback & API Key Rotation Demo ===\n");

  // --- Fallback candidate resolution ---
  console.log("--- Candidate resolution ---\n");
  const candidates = resolveFallbackCandidates("anthropic", "claude-sonnet-4-20250514", [
    "openai/gpt-4o",
    "google/gemini-2.5-flash",
  ]);
  console.log("  Candidates:");
  for (const c of candidates) console.log(`    ${c.provider}/${c.model}`);

  // --- Successful fallback ---
  console.log("\n--- Scenario 1: Primary fails, fallback succeeds ---\n");
  clearCooldowns();

  let attempt = 0;
  const result1 = await runWithModelFallback({
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    fallbacks: ["openai/gpt-4o", "google/gemini-2.5-flash"],
    run: async (provider, model) => {
      attempt++;
      console.log(`  Attempt ${attempt}: trying ${provider}/${model}...`);
      if (provider === "anthropic") {
        throw new Error("503 Service Unavailable: overloaded");
      }
      if (provider === "openai") {
        throw new Error("429 Too Many Requests: rate limit");
      }
      return `Response from ${provider}/${model}`;
    },
  });

  console.log(`  Result: "${result1.result}"`);
  console.log(`  Used: ${result1.provider}/${result1.model}`);
  console.log(`  Failed attempts: ${result1.attempts.length}`);
  for (const a of result1.attempts) {
    console.log(`    ${a.provider}/${a.model}: ${a.reason} — ${a.error.slice(0, 60)}`);
  }

  // --- All fail ---
  console.log("\n--- Scenario 2: All models fail → FallbackSummaryError ---\n");
  clearCooldowns();

  try {
    await runWithModelFallback({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      fallbacks: ["openai/gpt-4o"],
      run: async (provider) => {
        throw new Error(`503 ${provider} is down`);
      },
    });
  } catch (err) {
    if (isFallbackSummaryError(err)) {
      console.log(`  FallbackSummaryError: ${err.message.slice(0, 80)}...`);
      console.log(`  Attempts: ${err.attempts.length}`);
      console.log(`  Soonest cooldown: ${err.soonestCooldownExpiry ? new Date(err.soonestCooldownExpiry).toISOString() : "none"}`);
    }
  }

  // --- Cooldown tracking ---
  console.log("\n--- Scenario 3: Cooldown tracking ---\n");
  clearCooldowns();

  recordProviderCooldown("anthropic", "billing");
  recordProviderCooldown("openai", "rate_limit", "gpt-4o");

  console.log(`  anthropic in cooldown? ${isProviderInCooldown("anthropic")}`);
  console.log(`  openai/gpt-4o in cooldown? ${isProviderInCooldown("openai", "gpt-4o")}`);
  console.log(`  openai/gpt-4-turbo in cooldown? ${isProviderInCooldown("openai", "gpt-4-turbo")} (model-scoped bypass)`);

  const soonest = getSoonestCooldownExpiry(candidates);
  if (soonest) {
    const secsLeft = Math.max(0, Math.round((soonest - Date.now()) / 1000));
    console.log(`  Soonest cooldown expires in: ${secsLeft}s`);
  }

  // Fallback skips cooled-down providers automatically
  const result3 = await runWithModelFallback({
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    fallbacks: ["openai/gpt-4o", "google/gemini-2.5-flash"],
    run: async (provider, model) => {
      console.log(`  Running on ${provider}/${model} (not in cooldown)`);
      return `OK from ${provider}/${model}`;
    },
  });
  console.log(`  Result: "${result3.result}"`);
  console.log(`  Skipped attempts: ${result3.attempts.length}`);

  // --- Context overflow short-circuit ---
  console.log("\n--- Scenario 4: Context overflow → no fallback ---\n");
  clearCooldowns();

  try {
    await runWithModelFallback({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      fallbacks: ["openai/gpt-4o"],
      run: async () => {
        throw new Error("context length exceeded: 200000 tokens > 128000 max");
      },
    });
  } catch (err) {
    console.log(`  Threw immediately: "${(err as Error).message.slice(0, 60)}..."`);
    console.log(`  Is FallbackSummaryError? ${isFallbackSummaryError(err)} (should be false)`);
  }

  // --- API key rotation ---
  console.log("\n--- Scenario 5: API key rotation ---\n");

  let keyAttempt = 0;
  const result5 = await executeWithApiKeyRotation({
    provider: "openai",
    apiKeys: ["sk-key-1-rate-limited", "sk-key-2-rate-limited", "sk-key-3-works"],
    execute: async (apiKey) => {
      keyAttempt++;
      console.log(`  Key attempt ${keyAttempt}: ${apiKey.slice(0, 20)}...`);
      if (apiKey.includes("rate-limited")) {
        throw new Error("429 rate limit exceeded for this key");
      }
      return `Success with ${apiKey}`;
    },
  });
  console.log(`  Result: "${result5}"`);

  // --- Env-based key collection ---
  console.log("\n--- Key collection from env vars ---\n");
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-primary";
  process.env["ANTHROPIC_API_KEYS"] = "sk-ant-list-1,sk-ant-list-2";
  process.env["ANTHROPIC_API_KEY_1"] = "sk-ant-numbered-1";

  const keys = collectProviderApiKeysForExecution({
    provider: "anthropic",
    primaryApiKey: "sk-ant-explicit",
  });
  console.log(`  Collected ${keys.length} keys for anthropic:`);
  for (const k of keys) console.log(`    ${k.slice(0, 20)}...`);

  delete process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_API_KEYS"];
  delete process.env["ANTHROPIC_API_KEY_1"];

  clearCooldowns();
  console.log("\nDemo complete.");
}

main().catch(console.error);
