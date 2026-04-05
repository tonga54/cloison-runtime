export {
  createRuntime,
  type AgentRuntime,
  type AgentRunOptions,
  type AgentRunResult,
} from "./agent.js";

export {
  runWithModelFallback,
  resolveFallbackCandidates,
  parseFallbackRef,
  FallbackSummaryError,
  isFallbackSummaryError,
  LiveSessionModelSwitchError,
  recordProviderCooldown,
  isProviderInCooldown,
  getSoonestCooldownExpiry,
  clearCooldowns,
  type ModelCandidate,
  type FallbackAttempt,
  type ModelFallbackRunResult,
} from "./model-fallback.js";

export {
  FailoverError,
  isFailoverError,
  coerceToFailoverError,
  describeFailoverError,
  resolveFailoverReasonFromError,
  isLikelyContextOverflowError,
  isContextOverflowError,
  isTimeoutError,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
  isBillingErrorMessage,
  classifyFailoverSignal,
  isImageDimensionErrorMessage,
  isImageSizeError,
  isCliSessionExpiredErrorMessage,
  isPeriodicUsageLimitErrorMessage,
  matchesProviderContextOverflow,
  classifyProviderSpecificError,
  isAuthPermanentErrorMessage,
  isAuthErrorMessage,
  isModelNotFoundErrorMessage,
  isOverloadedErrorMessage,
  isTransientHttpError,
  type FailoverReason,
  type FailoverSignal,
  type FailoverClassification,
} from "./failover-error.js";

export {
  shouldAllowCooldownProbeForReason,
  shouldUseTransientCooldownProbeSlot,
  shouldPreserveTransientCooldownProbeSlot,
} from "./failover-policy.js";

export {
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
  estimateTokens,
  estimateMessagesTokens,
  type ContextWindowInfo,
  type ContextWindowGuardResult,
} from "./context-guard.js";

export {
  retryAsync,
  isRetryableError,
  resolveRetryConfig,
  type RetryOptions,
  type RetryConfig,
  type RetryInfo,
} from "./retry.js";

export {
  executeWithApiKeyRotation,
  collectProviderApiKeys,
  type ApiKeyRotationOptions,
} from "./api-key-rotation.js";

export {
  spawnSubagentsParallel,
  createSubagentRegistry,
  createSubagentTool,
  type SubagentTask,
  type SubagentResult,
  type SubagentRunRecord,
  type SubagentRegistry,
  type SubagentSpawnOptions,
} from "./subagent.js";

export {
  pruneContextMessages,
  type SessionPruningOptions,
  type PruneResult,
} from "./session-pruning.js";

export {
  truncateToolResultText,
  calculateMaxToolResultChars,
  truncateOversizedToolResultsInMessages,
  truncateOversizedToolResultsInSession,
  sessionLikelyHasOversizedToolResults,
} from "./tool-result-truncation.js";

export {
  shouldRunMemoryFlush,
  createMemoryFlushState,
  markMemoryFlushed,
  estimateSessionTokens,
  MEMORY_FLUSH_PROMPT,
  MEMORY_FLUSH_SYSTEM_PROMPT,
  type MemoryFlushConfig,
  type MemoryFlushState,
} from "./memory-flush.js";

export {
  resolveStreamAdapter,
  applyStreamHeaders,
  applyStreamPayloadTransform,
  resolveStreamBaseUrl,
  type StreamAdapterConfig,
  type ProviderStreamConfig,
} from "./stream-adapters.js";
