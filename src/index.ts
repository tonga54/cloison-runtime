// Platform (Multi-Tenant)
export {
  createPlatform,
  type Platform,
  type PlatformConfig,
} from "./platform/index.js";

// Workspace
export {
  createWorkspace,
  validateWorkspaceId,
  loadWorkspaceConfig,
  type Workspace,
  type WorkspaceConfig,
  type WorkspaceId,
  type WorkspaceRunOptions,
  type CreateWorkspaceOptions,
} from "./workspace/index.js";

// Agent Runtime (single-user, kept for backward compatibility)
export {
  createRuntime,
  type AgentRuntime,
  type AgentRunOptions,
  type AgentRunResult,
} from "./runtime/index.js";

// Hooks
export {
  createHookRunner,
  type HookRunner,
  type HookName,
  type HookHandler,
  type HookPayload,
  type BeforeAgentStartPayload,
  type AfterAgentEndPayload,
  type BeforeToolCallPayload,
  type AfterToolCallPayload,
  type SessionStartPayload,
  type SessionEndPayload,
} from "./hooks/index.js";

// Memory
export {
  createSimpleMemoryManager,
  type SimpleMemoryManager,
} from "./memory/index.js";
export {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type CreateEmbeddingProviderOptions,
} from "./memory/embeddings.js";
export type {
  MemorySearchResult,
  MemorySearchManager,
} from "./memory/types.js";

// Embedding Cache
export {
  createEmbeddingCache,
  hashContent,
  type EmbeddingCache,
} from "./memory/embedding-cache.js";

// Batch Embedding
export {
  embedBatchWithCacheAndRetry,
  embedQueryWithTimeout,
  runBatchWithFallback,
  createBatchFailureState,
  type BatchEmbeddingOptions,
  type BatchEmbeddingResult,
  type BatchFailureState,
} from "./memory/embedding-batch.js";

// File-based Memory Indexing
export {
  createFileIndexer,
  type FileIndexer,
  type FileIndexerOptions,
  type FileIndexSyncResult,
} from "./memory/file-indexer.js";

// Session Transcript Indexing (Compaction Awareness)
export {
  createSessionIndexer,
  type SessionIndexer,
  type SessionIndexerOptions,
  type SessionIndexResult,
} from "./memory/session-indexer.js";

// SSRF Protection
export {
  buildBaseUrlPolicy,
  validateUrl,
  fetchWithSsrfGuard,
  type SsrfPolicy,
} from "./memory/ssrf.js";

// Sessions
export {
  loadSessionStore,
  saveSessionStore,
  getOrCreateSession,
  updateSession,
  type SessionEntry,
  type SessionStore,
} from "./sessions/index.js";

// Skills
export {
  loadWorkspaceSkills,
  type Skill,
  type SkillSnapshot,
  createSkillRegistry,
  type SkillRegistry,
  type SkillRegistryEntry,
  createSkillEnablement,
  type SkillEnablement,
} from "./skills/index.js";

// Credentials
export {
  createCredentialStore,
  createCredentialProxy,
  type CredentialStore,
  type CredentialProxy,
  type CredentialEntry,
  type CreateCredentialStoreOptions,
} from "./credentials/index.js";

// Sandbox
export {
  createSandboxManager,
  createIpcServer,
  createIpcClient,
  detectCapabilities,
  buildDefaultProfile,
  buildRestrictedProfile,
  type SandboxConfig,
  type SandboxCapabilities,
  type SandboxManager,
  type SandboxProcess,
  type SandboxSpawnOptions,
  type IpcServer,
  type IpcClient,
  type IpcMessage,
  type MountBind,
} from "./sandbox/index.js";

// Seccomp-BPF Application
export {
  ensureSeccompLoader,
  buildSeccompWrapperArgs,
  isSeccompAvailable,
} from "./sandbox/seccomp-apply.js";

// Config
export {
  loadConfig,
  resolveStateDir,
  type AgentRuntimeConfig,
} from "./config/index.js";

// Logging
export {
  createSubsystemLogger,
  configureLogger,
  type SubsystemLogger,
  type LogLevel,
  type LoggerConfig,
} from "./logging/subsystem.js";

// Model Fallback
export {
  runWithModelFallback,
  resolveFallbackCandidates,
  FallbackSummaryError,
  isFallbackSummaryError,
  type ModelCandidate,
  type FallbackAttempt,
  type ModelFallbackRunResult,
} from "./runtime/model-fallback.js";

// Failover Error System
export {
  FailoverError,
  isFailoverError,
  coerceToFailoverError,
  describeFailoverError,
  resolveFailoverReasonFromError,
  isLikelyContextOverflowError,
  isContextOverflowError as isContextOverflowErrorMessage,
  isTimeoutError,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
  isBillingErrorMessage,
  classifyFailoverSignal,
  type FailoverReason,
  type FailoverSignal,
  type FailoverClassification,
} from "./runtime/failover-error.js";

// Transcript Events
export {
  onSessionTranscriptUpdate,
  emitSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "./sessions/transcript-events.js";

// Context Window Guard
export {
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
  estimateTokens,
  estimateMessagesTokens,
  type ContextWindowInfo,
  type ContextWindowGuardResult,
} from "./runtime/context-guard.js";

// Retry
export {
  retryAsync,
  isRetryableError,
  resolveRetryConfig,
  type RetryOptions,
  type RetryConfig,
  type RetryInfo,
} from "./runtime/retry.js";

// API Key Rotation
export {
  executeWithApiKeyRotation,
  collectProviderApiKeys,
  type ApiKeyRotationOptions,
} from "./runtime/api-key-rotation.js";

// Subagent System
export {
  spawnSubagentsParallel,
  createSubagentRegistry,
  createSubagentTool,
  type SubagentTask,
  type SubagentResult,
  type SubagentRunRecord,
  type SubagentRegistry,
  type SubagentSpawnOptions,
} from "./runtime/subagent.js";

// Session Pruning
export {
  pruneContextMessages,
  type SessionPruningOptions,
  type PruneResult,
} from "./runtime/session-pruning.js";

// Tool Result Truncation
export {
  truncateToolResultText,
  calculateMaxToolResultChars,
  truncateOversizedToolResultsInMessages,
  truncateOversizedToolResultsInSession,
  sessionLikelyHasOversizedToolResults,
} from "./runtime/tool-result-truncation.js";

// Memory Flush
export {
  shouldRunMemoryFlush,
  createMemoryFlushState,
  markMemoryFlushed,
  estimateSessionTokens,
  MEMORY_FLUSH_PROMPT,
  MEMORY_FLUSH_SYSTEM_PROMPT,
  type MemoryFlushConfig,
  type MemoryFlushState,
} from "./runtime/memory-flush.js";

// Stream Adapters
export {
  resolveStreamAdapter,
  applyStreamHeaders,
  applyStreamPayloadTransform,
  resolveStreamBaseUrl,
  type StreamAdapterConfig,
  type ProviderStreamConfig,
} from "./runtime/stream-adapters.js";

// Re-export key types from the underlying SDK
export type {
  AgentSessionEvent,
  ToolDefinition,
  Skill as PiSkill,
} from "@mariozechner/pi-coding-agent";
