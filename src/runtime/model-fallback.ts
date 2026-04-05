// Ported from OpenClaw src/agents/model-fallback.ts
// Removed: auth profile store, cooldown probes, image model fallback, model alias index
// Kept: all fallback logic, error classification, context overflow short-circuit

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  FailoverError,
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
  isLikelyContextOverflowError,
  type FailoverReason,
} from "./failover-error.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";

const log = createSubsystemLogger("model-fallback");

export type { ModelCandidate, FallbackAttempt } from "./model-fallback.types.js";

// --- Cooldown tracking (adapted from OpenClaw auth-profiles/usage.ts) ---

const MIN_PROBE_INTERVAL_MS = 30_000;
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const BILLING_COOLDOWN_MS = 5 * 60_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;

interface CooldownEntry {
  until: number;
  reason: FailoverReason;
  model?: string;
}

export interface CooldownStore {
  providerCooldowns: Map<string, CooldownEntry>;
  lastProbeAttempt: Map<string, number>;
}

export function createCooldownStore(): CooldownStore {
  return {
    providerCooldowns: new Map(),
    lastProbeAttempt: new Map(),
  };
}

const globalStore = createCooldownStore();

function resolveStore(store?: CooldownStore): CooldownStore {
  return store ?? globalStore;
}

function cooldownKey(provider: string, model?: string): string {
  return model ? `${provider}/${model}` : provider;
}

function getCooldownMs(reason: FailoverReason): number {
  switch (reason) {
    case "rate_limit": case "overloaded": return RATE_LIMIT_COOLDOWN_MS;
    case "billing": return BILLING_COOLDOWN_MS;
    case "auth": case "auth_permanent": return AUTH_COOLDOWN_MS;
    default: return DEFAULT_COOLDOWN_MS;
  }
}

export function recordProviderCooldown(
  provider: string,
  reason: FailoverReason,
  model?: string,
  store?: CooldownStore,
): void {
  const s = resolveStore(store);
  const key = cooldownKey(provider, model);
  const until = Date.now() + getCooldownMs(reason);
  s.providerCooldowns.set(key, { until, reason, model });
  if (reason !== "rate_limit" && reason !== "overloaded") {
    s.providerCooldowns.set(cooldownKey(provider), { until, reason });
  }
}

export function isProviderInCooldown(provider: string, model?: string, store?: CooldownStore): boolean {
  const s = resolveStore(store);
  const now = Date.now();
  const providerEntry = s.providerCooldowns.get(cooldownKey(provider));
  if (providerEntry && now < providerEntry.until) {
    if (providerEntry.reason === "rate_limit" && model && providerEntry.model && providerEntry.model !== model) {
      return false;
    }
    return true;
  }
  if (model) {
    const modelEntry = s.providerCooldowns.get(cooldownKey(provider, model));
    if (modelEntry && now < modelEntry.until) return true;
  }
  return false;
}

export function getSoonestCooldownExpiry(candidates: ModelCandidate[], store?: CooldownStore): number | null {
  const s = resolveStore(store);
  let soonest: number | null = null;
  for (const c of candidates) {
    const entry = s.providerCooldowns.get(cooldownKey(c.provider, c.model))
      ?? s.providerCooldowns.get(cooldownKey(c.provider));
    if (!entry) continue;
    if (soonest === null || entry.until < soonest) soonest = entry.until;
  }
  return soonest;
}

function shouldProbe(provider: string, store: CooldownStore): boolean {
  const now = Date.now();
  const last = store.lastProbeAttempt.get(provider) ?? 0;
  if (now - last < MIN_PROBE_INTERVAL_MS) return false;
  const entry = store.providerCooldowns.get(cooldownKey(provider));
  if (!entry) return true;
  return now >= entry.until - PROBE_MARGIN_MS;
}

function markProbe(provider: string, store: CooldownStore): void {
  store.lastProbeAttempt.set(provider, Date.now());
}

export function clearCooldowns(store?: CooldownStore): void {
  const s = resolveStore(store);
  s.providerCooldowns.clear();
  s.lastProbeAttempt.clear();
}

// --- LiveSessionModelSwitchError (from OpenClaw live-model-switch.ts) ---

export class LiveSessionModelSwitchError extends Error {
  provider: string;
  model: string;

  constructor(provider: string, model: string) {
    super(`Live session model switch requested: ${provider}/${model}`);
    this.name = "LiveSessionModelSwitchError";
    this.provider = provider;
    this.model = model;
  }
}

export class FallbackSummaryError extends Error {
  readonly attempts: FallbackAttempt[];
  readonly soonestCooldownExpiry: number | null;

  constructor(
    message: string,
    attempts: FallbackAttempt[],
    soonestCooldownExpiry: number | null,
    cause?: Error,
  ) {
    super(message, { cause });
    this.name = "FallbackSummaryError";
    this.attempts = attempts;
    this.soonestCooldownExpiry = soonestCooldownExpiry;
  }
}

export function isFallbackSummaryError(err: unknown): err is FallbackSummaryError {
  return err instanceof FallbackSummaryError;
}

export type ModelFallbackRunOptions = {
  allowTransientCooldownProbe?: boolean;
};

type ModelFallbackRunFn<T> = (
  provider: string,
  model: string,
  options?: ModelFallbackRunOptions,
) => Promise<T>;

type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

export type ModelFallbackRunResult<T> = {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

function isFallbackAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isFailoverError(err)) return false;
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isFallbackAbortError(err) && !isTimeoutError(err);
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function normalizeModelRef(provider: string, model: string): ModelCandidate {
  return { provider: provider.trim(), model: model.trim() };
}

export function parseFallbackRef(raw: string, defaultProvider: string): ModelCandidate {
  const parts = raw.split("/");
  if (parts.length >= 2) {
    return { provider: parts[0], model: parts.slice(1).join("/") };
  }
  return { provider: defaultProvider, model: raw };
}

export function resolveFallbackCandidates(
  provider: string,
  model: string,
  fallbacks?: string[],
): ModelCandidate[] {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate) => {
    if (!candidate.provider || !candidate.model) return;
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  addCandidate(normalizeModelRef(provider, model));

  for (const raw of fallbacks ?? []) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) continue;
    addCandidate(parseFallbackRef(trimmed, provider));
  }

  return candidates;
}

async function runFallbackCandidate<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  options?: ModelFallbackRunOptions;
}): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
  try {
    const result = params.options
      ? await params.run(params.provider, params.model, params.options)
      : await params.run(params.provider, params.model);
    return { ok: true, result };
  } catch (err) {
    const normalizedFailover = coerceToFailoverError(err, {
      provider: params.provider,
      model: params.model,
    });
    if (shouldRethrowAbort(err) && !normalizedFailover) throw err;
    return { ok: false, error: normalizedFailover ?? err };
  }
}

function throwFallbackFailureSummary(params: {
  attempts: FallbackAttempt[];
  candidates: ModelCandidate[];
  lastError: unknown;
  label: string;
  formatAttempt: (attempt: FallbackAttempt) => string;
  soonestCooldownExpiry?: number | null;
}): never {
  if (params.attempts.length <= 1 && params.lastError) throw params.lastError;
  const summary =
    params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
  throw new FallbackSummaryError(
    `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`,
    params.attempts,
    params.soonestCooldownExpiry ?? null,
    params.lastError instanceof Error ? params.lastError : undefined,
  );
}

export async function runWithModelFallback<T>(params: {
  provider: string;
  model: string;
  fallbacks?: string[];
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  cooldownStore?: CooldownStore;
}): Promise<ModelFallbackRunResult<T>> {
  const store = resolveStore(params.cooldownStore);
  const candidates = resolveFallbackCandidates(
    params.provider,
    params.model,
    params.fallbacks,
  );
  const hasFallbackCandidates = candidates.length > 1;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const isPrimary = i === 0;

    if (isProviderInCooldown(candidate.provider, candidate.model, store)) {
      const isProbable = isPrimary && hasFallbackCandidates && shouldProbe(candidate.provider, store);
      if (!isProbable) {
        const entry = store.providerCooldowns.get(cooldownKey(candidate.provider, candidate.model))
          ?? store.providerCooldowns.get(cooldownKey(candidate.provider));
        const reason = entry?.reason ?? "unknown";
        if (reason === "auth" || reason === "auth_permanent" || reason === "billing") {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: `Provider ${candidate.provider} has ${reason} issue (skipping)`,
            reason,
          });
          log.debug(`skipping ${candidate.provider}/${candidate.model}: ${reason} cooldown`);
          continue;
        }
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: `Provider ${candidate.provider} is in cooldown`,
          reason,
        });
        log.debug(`skipping ${candidate.provider}/${candidate.model}: cooldown`);
        continue;
      }
      markProbe(candidate.provider, store);
      log.debug(`probing ${candidate.provider}/${candidate.model} despite cooldown`);
    }

    const runResult = await runFallbackCandidate({
      run: params.run,
      ...candidate,
    });

    if (runResult.ok) {
      if (i > 0 || attempts.length > 0) {
        log.info(
          `fallback succeeded: ${candidate.provider}/${candidate.model} after ${i} failures`,
        );
      }
      return {
        result: runResult.result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    }

    const err = runResult.error;

    // Context overflow: throw immediately, do not try fallback models
    const errMessage = err instanceof Error ? err.message : String(err);
    if (isLikelyContextOverflowError(errMessage)) throw err;

    // LiveSessionModelSwitchError: wrap as overloaded to continue chain
    if (err instanceof LiveSessionModelSwitchError) {
      const switchNormalized = new FailoverError(errMessage, {
        reason: "overloaded",
        provider: candidate.provider,
        model: candidate.model,
      });
      lastError = switchNormalized;
      const described = describeFailoverError(switchNormalized);
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described.message,
        reason: described.reason ?? "unknown",
        status: described.status,
        code: described.code,
      });
      continue;
    }

    const normalized =
      coerceToFailoverError(err, {
        provider: candidate.provider,
        model: candidate.model,
      }) ?? err;

    const isKnownFailover = isFailoverError(normalized);
    if (!isKnownFailover && i === candidates.length - 1) throw err;

    lastError = isKnownFailover ? normalized : err;
    const described = describeFailoverError(normalized);

    if (described.reason && described.reason !== "format" && described.reason !== "unknown") {
      recordProviderCooldown(candidate.provider, described.reason, candidate.model, store);
    }

    attempts.push({
      provider: candidate.provider,
      model: candidate.model,
      error: described.message,
      reason: described.reason ?? "unknown",
      status: described.status,
      code: described.code,
    });

    log.warn(
      `${candidate.provider}/${candidate.model} failed: ${described.message}` +
        (described.reason ? ` (${described.reason})` : ""),
    );

    await params.onError?.({
      provider: candidate.provider,
      model: candidate.model,
      error: isKnownFailover ? normalized : err,
      attempt: i + 1,
      total: candidates.length,
    });
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "models",
    formatAttempt: (attempt) =>
      `${attempt.provider}/${attempt.model}: ${attempt.error}${
        attempt.reason ? ` (${attempt.reason})` : ""
      }`,
    soonestCooldownExpiry: getSoonestCooldownExpiry(candidates, store),
  });
}
