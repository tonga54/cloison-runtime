// Ported from OpenClaw src/agents/api-key-rotation.ts + src/agents/live-auth-keys.ts

// --- Key collection (from live-auth-keys.ts) ---

const KEY_SPLIT_RE = /[\s,;]+/g;

const PROVIDER_PREFIX_OVERRIDES: Record<string, string> = {
  google: "GEMINI",
  "google-vertex": "GEMINI",
};

type ProviderApiKeyConfig = {
  liveSingle?: string;
  listVar?: string;
  primaryVar?: string;
  prefixedVar?: string;
  fallbackVars: string[];
};

const PROVIDER_API_KEY_CONFIG: Record<string, Omit<ProviderApiKeyConfig, "fallbackVars">> = {
  anthropic: {
    liveSingle: "CLOISON_LIVE_ANTHROPIC_KEY",
    listVar: "CLOISON_LIVE_ANTHROPIC_KEYS",
    primaryVar: "ANTHROPIC_API_KEY",
    prefixedVar: "ANTHROPIC_API_KEY_",
  },
  google: {
    liveSingle: "CLOISON_LIVE_GEMINI_KEY",
    listVar: "GEMINI_API_KEYS",
    primaryVar: "GEMINI_API_KEY",
    prefixedVar: "GEMINI_API_KEY_",
  },
  "google-vertex": {
    liveSingle: "CLOISON_LIVE_GEMINI_KEY",
    listVar: "GEMINI_API_KEYS",
    primaryVar: "GEMINI_API_KEY",
    prefixedVar: "GEMINI_API_KEY_",
  },
  openai: {
    liveSingle: "CLOISON_LIVE_OPENAI_KEY",
    listVar: "OPENAI_API_KEYS",
    primaryVar: "OPENAI_API_KEY",
    prefixedVar: "OPENAI_API_KEY_",
  },
};

function normalizeProviderId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function parseKeyList(raw?: string | null): string[] {
  if (!raw) return [];
  return raw.split(KEY_SPLIT_RE).map((v) => v.trim()).filter(Boolean);
}

function collectEnvPrefixedKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(prefix)) continue;
    const trimmed = value?.trim();
    if (!trimmed) continue;
    keys.push(trimmed);
  }
  return keys;
}

function resolveProviderApiKeyConfig(provider: string): ProviderApiKeyConfig {
  const normalized = normalizeProviderId(provider);
  const custom = PROVIDER_API_KEY_CONFIG[normalized];
  const base = PROVIDER_PREFIX_OVERRIDES[normalized] ?? normalized.toUpperCase().replace(/-/g, "_");

  const liveSingle = custom?.liveSingle ?? `CLOISON_LIVE_${base}_KEY`;
  const listVar = custom?.listVar ?? `${base}_API_KEYS`;
  const primaryVar = custom?.primaryVar ?? `${base}_API_KEY`;
  const prefixedVar = custom?.prefixedVar ?? `${base}_API_KEY_`;

  if (normalized === "google" || normalized === "google-vertex") {
    return { liveSingle, listVar, primaryVar, prefixedVar, fallbackVars: ["GOOGLE_API_KEY"] };
  }

  return { liveSingle, listVar, primaryVar, prefixedVar, fallbackVars: [] };
}

export function collectProviderApiKeys(provider: string): string[] {
  const config = resolveProviderApiKeyConfig(provider);

  const forcedSingle = config.liveSingle ? process.env[config.liveSingle]?.trim() : undefined;
  if (forcedSingle) return [forcedSingle];

  const fromList = parseKeyList(config.listVar ? process.env[config.listVar] : undefined);
  const primary = config.primaryVar ? process.env[config.primaryVar]?.trim() : undefined;
  const fromPrefixed = config.prefixedVar ? collectEnvPrefixedKeys(config.prefixedVar) : [];
  const fallback = config.fallbackVars
    .map((envVar) => process.env[envVar]?.trim())
    .filter(Boolean) as string[];

  const seen = new Set<string>();
  const add = (value?: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
  };

  for (const value of fromList) add(value);
  add(primary);
  for (const value of fromPrefixed) add(value);
  for (const value of fallback) add(value);

  return Array.from(seen);
}

export function isApiKeyRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("rate_limit")) return true;
  if (lower.includes("rate limit")) return true;
  if (lower.includes("429")) return true;
  if (lower.includes("quota exceeded") || lower.includes("quota_exceeded")) return true;
  if (lower.includes("resource exhausted") || lower.includes("resource_exhausted")) return true;
  if (lower.includes("too many requests")) return true;
  return false;
}

export function isAnthropicBillingError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("credit balance")) return true;
  if (lower.includes("insufficient credit")) return true;
  if (lower.includes("insufficient credits")) return true;
  if (lower.includes("payment required")) return true;
  if (lower.includes("billing") && lower.includes("disabled")) return true;
  if (
    /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\spayment/i.test(lower)
  ) return true;
  return false;
}

// --- API key rotation (from api-key-rotation.ts) ---

function dedupeApiKeys(raw: string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of raw) {
    const apiKey = value.trim();
    if (!apiKey || seen.has(apiKey)) continue;
    seen.add(apiKey);
    keys.push(apiKey);
  }
  return keys;
}

export function collectProviderApiKeysForExecution(params: {
  provider: string;
  primaryApiKey?: string;
}): string[] {
  const { primaryApiKey, provider } = params;
  return dedupeApiKeys([primaryApiKey?.trim() ?? "", ...collectProviderApiKeys(provider)]);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ApiKeyRotationOptions<T> {
  provider: string;
  apiKeys: string[];
  execute: (apiKey: string) => Promise<T>;
  shouldRetry?: (params: {
    apiKey: string;
    error: unknown;
    attempt: number;
    message: string;
  }) => boolean;
  onRetry?: (params: {
    apiKey: string;
    error: unknown;
    attempt: number;
    message: string;
  }) => void;
}

export async function executeWithApiKeyRotation<T>(
  params: ApiKeyRotationOptions<T>,
): Promise<T> {
  const keys = dedupeApiKeys(params.apiKeys);
  if (keys.length === 0) {
    throw new Error(`No API keys configured for provider "${params.provider}".`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const apiKey = keys[attempt];
    try {
      return await params.execute(apiKey);
    } catch (error) {
      lastError = error;
      const message = formatErrorMessage(error);
      const retryable = params.shouldRetry
        ? params.shouldRetry({ apiKey, error, attempt, message })
        : isApiKeyRateLimitError(message);

      if (!retryable || attempt + 1 >= keys.length) break;
      params.onRetry?.({ apiKey, error, attempt, message });
    }
  }

  if (lastError === undefined) {
    throw new Error(`Failed to run API request for ${params.provider}.`);
  }
  throw lastError;
}
