# Model Fallback & API Key Rotation

When a model fails, Cloison automatically falls back to the next candidate. The error classification engine — ported from [OpenClaw](https://github.com/nicepkg/openclaw) — covers rate limits, billing, auth, overload, timeout, model not found, context overflow, and provider-specific patterns.

## Model Fallback

```typescript
const result = await runtime.run({
  message: "Analyze this codebase",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  fallbacks: ["openai/gpt-4o", "google/gemini-2.5-flash"],
});
```

If Anthropic fails (rate limit, overload, etc.), it tries OpenAI, then Google. Providers in cooldown are skipped automatically.

## Error Classification

The classifier handles:

| Signal | Examples |
|--------|----------|
| **rate_limit** | 429, quota exceeded, resource exhausted, too many requests |
| **billing** | Credit balance too low, payment required, insufficient credits |
| **auth** | Invalid API key, 401/403 |
| **auth_permanent** | Revoked key, disabled account |
| **overloaded** | 529, model not ready, service unavailable |
| **timeout** | Socket hang up, fetch failed, 408/500/503 |
| **context_overflow** | Context length exceeded, prompt too long |
| **model_not_found** | Model not found, model deactivated |

Provider-specific patterns: AWS Bedrock, Groq, Azure, Ollama, Mistral, Vertex, and more.

## API Key Rotation

When a key is rate-limited, it rotates to the next one:

```typescript
const result = await runtime.run({
  message: "...",
  apiKeys: [process.env.KEY_1!, process.env.KEY_2!, process.env.KEY_3!],
});
```

Or via environment variables:

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_API_KEYS=sk-ant-key1,sk-ant-key2,sk-ant-key3
ANTHROPIC_API_KEY_1=sk-ant-...
ANTHROPIC_API_KEY_2=sk-ant-...
```

## Context Window Guards

Prevents silent failures from models with insufficient context windows:

```typescript
import { resolveContextWindowInfo, evaluateContextWindowGuard } from "cloison-runtime";

const info = resolveContextWindowInfo({
  modelContextWindow: model.contextWindow,
  configContextTokens: 16_000,
});

const guard = evaluateContextWindowGuard({ info });
// guard.shouldWarn  → true if below 32,000 tokens
// guard.shouldBlock → true if below 16,000 tokens
```

## Retry with Compaction

Transient errors trigger automatic retry with exponential backoff:

```typescript
const result = await runtime.run({
  message: "Refactor the auth module",
  maxRetries: 3,
});
// On context overflow → session compaction reduces history
// On 429/5xx → exponential backoff + jitter
```

## Cooldown Tracking

Failed providers enter a cooldown period. Subsequent requests skip them until cooldown expires, preventing wasted API calls.

## Source Files

- `src/runtime/model-fallback.ts` — Fallback chains + cooldown tracking
- `src/runtime/failover-error.ts` — Error classification engine
- `src/runtime/failover-policy.ts` — Cooldown probe policies
- `src/runtime/api-key-rotation.ts` — Per-provider key rotation
- `src/runtime/context-guard.ts` — Context window guards
- `src/runtime/retry.ts` — Exponential backoff with jitter
