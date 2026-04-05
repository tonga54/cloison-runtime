export const DEFAULT_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_PROVIDER = "anthropic";

export const LINUX_REQUIRED_MESSAGE =
  "Cloison Runtime requires Linux. " +
  "For local development on macOS/Windows, use the provided Dockerfile: docker compose run dev";

const PROVIDER_ENV_KEY_OVERRIDES: Record<string, string> = {
  google: "GEMINI_API_KEY",
  "google-vertex": "GEMINI_API_KEY",
};

export function buildProviderEnvKey(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_ENV_KEY_OVERRIDES[normalized]
    ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

export const PROTECTED_SYSTEM_ENV_KEYS = new Set([
  "PATH", "HOME", "NODE_ENV", "LANG", "TZ", "NODE_PATH",
]);
