import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("stream-adapters");

export interface StreamAdapterConfig {
  headers?: Record<string, string>;
  baseUrl?: string;
  transformPayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
}

export type ProviderStreamConfig = Record<string, StreamAdapterConfig>;

const KNOWN_PROVIDER_DEFAULTS: Record<string, Partial<StreamAdapterConfig>> = {
  anthropic: {},
  openai: {},
  google: {},
  groq: {},
  cerebras: {},
  mistral: {},
  xai: {},
};

export function resolveStreamAdapter(
  provider: string,
  config?: ProviderStreamConfig,
): StreamAdapterConfig | undefined {
  const providerConfig = config?.[provider];
  const defaults = KNOWN_PROVIDER_DEFAULTS[provider];

  if (!providerConfig && !defaults) return undefined;

  return {
    ...defaults,
    ...providerConfig,
  };
}

export function applyStreamHeaders(
  provider: string,
  headers: Record<string, string>,
  config?: ProviderStreamConfig,
): Record<string, string> {
  const adapter = resolveStreamAdapter(provider, config);
  if (!adapter?.headers) return headers;

  return { ...headers, ...adapter.headers };
}

export function applyStreamPayloadTransform(
  provider: string,
  payload: Record<string, unknown>,
  config?: ProviderStreamConfig,
): Record<string, unknown> {
  const adapter = resolveStreamAdapter(provider, config);
  if (!adapter?.transformPayload) return payload;

  try {
    return adapter.transformPayload(payload);
  } catch (err) {
    log.warn(`stream payload transform failed for ${provider}`, {
      error: String(err),
    });
    return payload;
  }
}

export function resolveStreamBaseUrl(
  provider: string,
  defaultBaseUrl: string,
  config?: ProviderStreamConfig,
): string {
  const adapter = resolveStreamAdapter(provider, config);
  return adapter?.baseUrl ?? defaultBaseUrl;
}
