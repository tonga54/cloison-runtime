import { buildBaseUrlPolicy, fetchWithSsrfGuard, type SsrfPolicy } from "./ssrf.js";

export type EmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

export type EmbeddingProviderId = "openai" | "gemini" | "voyage" | "mistral" | "ollama";

function sanitizeErrorBody(body: string): string {
  const truncated = body.slice(0, 500);
  return truncated
    .replace(/(?:sk-|sk-ant-|key-|pa-|AIza|Bearer\s+)[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/[?&]key=[^&\s"']{10,}/g, "?key=[REDACTED]")
    .replace(/"(api_key|apiKey|secret|token|password)"\s*:\s*"[^"]{6,}"/gi, '"$1":"[REDACTED]"');
}

const APPROX_CHARS_PER_TOKEN = 4;

function validateInputLength(text: string, maxTokens?: number): void {
  if (maxTokens && text.length > maxTokens * APPROX_CHARS_PER_TOKEN) {
    throw new Error(
      `Input text (~${Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)} tokens) exceeds provider limit of ${maxTokens} tokens`,
    );
  }
}

function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) return sanitized;
  return sanitized.map((value) => value / magnitude);
}

async function ssrfFetch(
  url: string,
  init: RequestInit,
  ssrfPolicy?: SsrfPolicy,
): Promise<Response> {
  if (ssrfPolicy) {
    return fetchWithSsrfGuard(url, init, ssrfPolicy);
  }
  return fetch(url, init);
}

interface BearerProviderConfig {
  id: EmbeddingProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxInputTokens?: number;
  ssrfPolicy?: SsrfPolicy;
}

function createBearerEmbeddingProvider(config: BearerProviderConfig): EmbeddingProvider {
  const { id, apiKey, model, baseUrl, maxInputTokens, ssrfPolicy } = config;

  async function call(input: string[]): Promise<number[][]> {
    const res = await ssrfFetch(
      `${baseUrl}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input, model }),
      },
      ssrfPolicy,
    );
    if (!res.ok) {
      throw new Error(`${id} embeddings failed (${res.status}): ${sanitizeErrorBody(await res.text())}`);
    }
    const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return body.data.map((d) => sanitizeAndNormalizeEmbedding(d.embedding));
  }

  return {
    id,
    model,
    maxInputTokens,
    embedQuery: async (text) => {
      validateInputLength(text, maxInputTokens);
      const results = await call([text]);
      if (!results || results.length === 0) {
        throw new Error(`${id} returned empty embedding response`);
      }
      return results[0];
    },
    embedBatch: async (texts) => {
      for (const t of texts) validateInputLength(t, maxInputTokens);
      return call(texts);
    },
  };
}

// --- OpenAI ---

const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

function createOpenAiProvider(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  enableSsrf?: boolean;
}): EmbeddingProvider {
  const model = params.model ?? "text-embedding-3-small";
  const baseUrl = (params.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return createBearerEmbeddingProvider({
    id: "openai",
    apiKey: params.apiKey,
    model,
    baseUrl,
    maxInputTokens: OPENAI_MAX_INPUT_TOKENS[model],
    ssrfPolicy: params.enableSsrf !== false ? buildBaseUrlPolicy(baseUrl) ?? undefined : undefined,
  });
}

// --- Gemini (different API shape — not Bearer-based) ---

const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "gemini-embedding-001": 2048,
  "text-embedding-004": 2048,
};

function createGeminiProvider(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  enableSsrf?: boolean;
}): EmbeddingProvider {
  const model = params.model ?? "gemini-embedding-001";
  const baseUrl = (params.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  const ssrfPolicy = params.enableSsrf !== false ? buildBaseUrlPolicy(baseUrl) ?? undefined : undefined;

  async function call(texts: string[]): Promise<number[][]> {
    const requests = texts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    }));
    const res = await ssrfFetch(
      `${baseUrl}/models/${model}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
        body: JSON.stringify({ requests }),
      },
      ssrfPolicy,
    );
    if (!res.ok) throw new Error(`gemini embeddings failed (${res.status}): ${sanitizeErrorBody(await res.text())}`);
    const body = (await res.json()) as { embeddings: Array<{ values: number[] }> };
    return body.embeddings.map((e) => sanitizeAndNormalizeEmbedding(e.values));
  }

  const maxTokens = GEMINI_MAX_INPUT_TOKENS[model];

  return {
    id: "gemini",
    model,
    maxInputTokens: maxTokens,
    embedQuery: async (text) => {
      validateInputLength(text, maxTokens);
      const results = await call([text]);
      if (!results || results.length === 0) throw new Error("gemini returned empty embedding response");
      return results[0];
    },
    embedBatch: async (texts) => {
      for (const t of texts) validateInputLength(t, maxTokens);
      return call(texts);
    },
  };
}

// --- Voyage ---

function createVoyageProvider(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  enableSsrf?: boolean;
}): EmbeddingProvider {
  const baseUrl = (params.baseUrl ?? "https://api.voyageai.com/v1").replace(/\/+$/, "");
  return createBearerEmbeddingProvider({
    id: "voyage",
    apiKey: params.apiKey,
    model: params.model ?? "voyage-3-lite",
    baseUrl,
    ssrfPolicy: params.enableSsrf !== false ? buildBaseUrlPolicy(baseUrl) ?? undefined : undefined,
  });
}

// --- Mistral ---

function createMistralProvider(params: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  enableSsrf?: boolean;
}): EmbeddingProvider {
  const baseUrl = (params.baseUrl ?? "https://api.mistral.ai/v1").replace(/\/+$/, "");
  return createBearerEmbeddingProvider({
    id: "mistral",
    apiKey: params.apiKey,
    model: params.model ?? "mistral-embed",
    baseUrl,
    ssrfPolicy: params.enableSsrf !== false ? buildBaseUrlPolicy(baseUrl) ?? undefined : undefined,
  });
}

// --- Ollama (different API shape — no auth, different response) ---

function createOllamaProvider(params: {
  model?: string;
  baseUrl?: string;
  enableSsrf?: boolean;
}): EmbeddingProvider {
  const model = params.model ?? "nomic-embed-text";
  const baseUrl = (params.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
  const ssrfPolicy = params.enableSsrf !== false ? buildBaseUrlPolicy(baseUrl) ?? undefined : undefined;

  async function call(input: string[]): Promise<number[][]> {
    const res = await ssrfFetch(
      `${baseUrl}/api/embed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input }),
      },
      ssrfPolicy,
    );
    if (!res.ok) throw new Error(`ollama embeddings failed (${res.status}): ${sanitizeErrorBody(await res.text())}`);
    const body = (await res.json()) as { embeddings: number[][] };
    return body.embeddings.map((v) => sanitizeAndNormalizeEmbedding(v));
  }

  return {
    id: "ollama",
    model,
    embedQuery: async (text) => {
      const results = await call([text]);
      if (!results || results.length === 0) throw new Error("ollama returned empty embedding response");
      return results[0];
    },
    embedBatch: call,
  };
}

// --- Factory ---

export type CreateEmbeddingProviderOptions = {
  provider: EmbeddingProviderId;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  enableSsrf?: boolean;
};

export function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions,
): EmbeddingProvider {
  const { provider, apiKey, model, baseUrl, enableSsrf } = options;

  switch (provider) {
    case "openai":
      if (!apiKey) throw new Error("OpenAI embedding provider requires an API key");
      return createOpenAiProvider({ apiKey, model, baseUrl, enableSsrf });
    case "gemini":
      if (!apiKey) throw new Error("Gemini embedding provider requires an API key");
      return createGeminiProvider({ apiKey, model, baseUrl, enableSsrf });
    case "voyage":
      if (!apiKey) throw new Error("Voyage embedding provider requires an API key");
      return createVoyageProvider({ apiKey, model, baseUrl, enableSsrf });
    case "mistral":
      if (!apiKey) throw new Error("Mistral embedding provider requires an API key");
      return createMistralProvider({ apiKey, model, baseUrl, enableSsrf });
    case "ollama":
      return createOllamaProvider({ model, baseUrl, enableSsrf });
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
