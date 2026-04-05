import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface AgentRuntimeConfig {
  model?: string;
  provider?: string;
  apiKey?: string;
  apiKeys?: string[];
  configPath?: string;
  stateDir?: string;
  workspaceDir?: string;
  systemPrompt?: string;
  skills?: { enabled?: boolean; dirs?: string[] };
  memory?: {
    enabled?: boolean;
    dir?: string;
    embeddingProvider?: {
      provider: "openai" | "gemini" | "voyage" | "mistral" | "ollama";
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      enableSsrf?: boolean;
    };
    enableEmbeddingCache?: boolean;
    maxCacheEntries?: number;
    fileIndexing?: {
      enabled?: boolean;
      watchPaths?: string[];
      debounceMs?: number;
    };
    sessionIndexing?: {
      enabled?: boolean;
      deltaBytes?: number;
      deltaMessages?: number;
    };
  };
  hooks?: { dirs?: string[] };
  fallbacks?: string[];
  contextTokens?: number;
  maxRetries?: number;
  logging?: {
    level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
    file?: string;
    maxFileBytes?: number;
    json?: boolean;
  };
  streamConfig?: Record<string, {
    headers?: Record<string, string>;
    baseUrl?: string;
  }>;
}

export function getDefaultStateDir(): string {
  return path.join(os.homedir(), ".cloison-runtime");
}

export function loadConfig(configPath?: string): AgentRuntimeConfig {
  const explicit = configPath ?? process.env["CLOISON_CONFIG_PATH"];
  const resolved = explicit ?? path.join(getDefaultStateDir(), "cloison-runtime.json");

  try {
    const raw = fs.readFileSync(resolved, "utf-8");
    return JSON.parse(raw) as AgentRuntimeConfig;
  } catch (err) {
    if (explicit) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load config from "${resolved}": ${msg}`);
    }
    return {};
  }
}

export function resolveStateDir(config: AgentRuntimeConfig): string {
  return (
    config.stateDir ??
    process.env["CLOISON_STATE_DIR"] ??
    getDefaultStateDir()
  );
}
