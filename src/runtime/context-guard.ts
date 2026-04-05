// Ported from OpenClaw src/agents/context-window-guard.ts
// Identical thresholds (16K hard min, 32K warn) and resolution logic.

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("context-guard");

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

const DEFAULT_CONTEXT_TOKENS = 128_000;
const CHARS_PER_TOKEN = 4;

export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export interface ContextWindowInfo {
  tokens: number;
  source: ContextWindowSource;
}

export interface ContextWindowGuardResult extends ContextWindowInfo {
  shouldWarn: boolean;
  shouldBlock: boolean;
}

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

export function resolveContextWindowInfo(params: {
  modelContextWindow?: number;
  configContextTokens?: number;
  modelsProviderConfig?: Array<{ id?: string; contextWindow?: number }>;
  modelId?: string;
  defaultTokens?: number;
}): ContextWindowInfo {
  // Check models.providers config first (highest priority override)
  if (params.modelsProviderConfig && params.modelId) {
    const match = params.modelsProviderConfig.find((m) => m?.id === params.modelId);
    const fromConfig = normalizePositiveInt(match?.contextWindow);
    if (fromConfig) return { tokens: fromConfig, source: "modelsConfig" };
  }

  const fromModel = normalizePositiveInt(params.modelContextWindow);
  const baseInfo: ContextWindowInfo = fromModel
    ? { tokens: fromModel, source: "model" }
    : { tokens: Math.floor(params.defaultTokens ?? DEFAULT_CONTEXT_TOKENS), source: "default" };

  const capTokens = normalizePositiveInt(params.configContextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}

export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(
    1,
    Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS),
  );
  const tokens = Math.max(0, Math.floor(params.info.tokens));

  const result: ContextWindowGuardResult = {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin,
  };

  if (result.shouldBlock) {
    log.error(`context window too small: ${tokens} tokens (minimum: ${hardMin})`);
  } else if (result.shouldWarn) {
    log.warn(`context window is small: ${tokens} tokens (recommended: >${warnBelow})`);
  }

  return result;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content ?? "") + 4;
  }
  return total;
}
