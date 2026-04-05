import {
  createAgentSession,
  SessionManager,
  codingTools,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { createHookRunner, type HookRunner } from "../hooks/index.js";
import { createSimpleMemoryManager, type SimpleMemoryManager } from "../memory/index.js";
import { createEmbeddingProvider } from "../memory/embeddings.js";
import {
  getOrCreateSession,
  updateSession,
} from "../sessions/index.js";
import { loadWorkspaceSkills, type SkillSnapshot } from "../skills/index.js";
import {
  loadConfig,
  resolveStateDir,
  type AgentRuntimeConfig,
} from "../config/index.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  LINUX_REQUIRED_MESSAGE,
  buildProviderEnvKey,
  resolveSessionManager,
  extractAssistantResponse,
} from "../shared/index.js";
import { createMemoryTools } from "./memory-tools.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
} from "./context-guard.js";
import { retryAsync } from "./retry.js";
import { isLikelyContextOverflowError, isTimeoutErrorMessage, isRateLimitErrorMessage } from "./failover-error.js";
import {
  executeWithApiKeyRotation,
  collectProviderApiKeys,
} from "./api-key-rotation.js";
import { createSubagentTool } from "./subagent.js";
import {
  shouldRunMemoryFlush,
  createMemoryFlushState,
  markMemoryFlushed,
  MEMORY_FLUSH_PROMPT,
  MEMORY_FLUSH_SYSTEM_PROMPT,
  type MemoryFlushState,
} from "./memory-flush.js";
import { createSubsystemLogger, configureLogger } from "../logging/subsystem.js";
import * as path from "node:path";
import * as fs from "node:fs";

const log = createSubsystemLogger("runtime");

export interface AgentRunOptions {
  message: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  apiKeys?: string[];
  workspaceDir?: string;
  systemPrompt?: string;
  configPath?: string;
  tools?: ToolDefinition[];
  onEvent?: AgentSessionEventListener;
  fallbacks?: string[];
  contextTokens?: number;
  maxRetries?: number;
  enableSubagents?: boolean;
}

export interface AgentRunResult {
  response: string;
  sessionId: string;
  provider?: string;
  model?: string;
  fallbackUsed?: boolean;
}

export interface AgentRuntime {
  run(options: AgentRunOptions): Promise<AgentRunResult>;
  hooks: HookRunner;
  memory: SimpleMemoryManager;
  config: AgentRuntimeConfig;
}

function assertLinux(): void {
  if (process.platform !== "linux") {
    throw new Error(LINUX_REQUIRED_MESSAGE);
  }
}

export async function createRuntime(
  overrides?: Partial<AgentRuntimeConfig>,
): Promise<AgentRuntime> {
  assertLinux();
  const fileConfig = loadConfig(overrides?.configPath);
  const config: AgentRuntimeConfig = { ...fileConfig, ...overrides };
  const stateDir = resolveStateDir(config);

  if (config.logging) {
    configureLogger(config.logging);
  }

  const hooks = createHookRunner();
  const memoryDir = config.memory?.dir ?? path.join(stateDir, "memory");

  // Create embedding provider from config if available
  const embeddingProvider = config.memory?.embeddingProvider
    ? createEmbeddingProvider(config.memory.embeddingProvider)
    : undefined;
  const memory = createSimpleMemoryManager({ dbDir: memoryDir, embeddingProvider });

  fs.mkdirSync(stateDir, { recursive: true });

  const memoryFlushState = createMemoryFlushState();

  async function run(options: AgentRunOptions): Promise<AgentRunResult> {
    const sessionId = options.sessionId ?? `session_${Date.now()}`;
    const requestedModelId = options.model ?? config.model ?? DEFAULT_MODEL;
    const requestedProvider =
      (options.provider ?? config.provider ?? DEFAULT_PROVIDER) as string;
    const workspaceDir =
      options.workspaceDir ?? config.workspaceDir ?? process.cwd();

    const sessionsDir = path.join(stateDir, "sessions", sessionId);
    fs.mkdirSync(sessionsDir, { recursive: true });

    await getOrCreateSession(stateDir, sessionId, { model: requestedModelId });

    await hooks.run("session_start", { sessionId });
    await hooks.run("before_agent_start", {
      sessionId,
      message: options.message,
      model: requestedModelId,
    });

    let skillsPrompt = "";
    if (config.skills?.enabled !== false) {
      try {
        const snapshot: SkillSnapshot = loadWorkspaceSkills(workspaceDir);
        skillsPrompt = snapshot.promptText;
      } catch {
        // skills loading is optional
      }
    }

    const systemPrompt = [
      options.systemPrompt ?? config.systemPrompt ?? "",
      skillsPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");

    async function executeWithModel(
      provider: string,
      modelId: string,
    ): Promise<AgentRunResult> {
      const envKey = buildProviderEnvKey(provider);

      const apiKeys: string[] = [];
      if (options.apiKey) apiKeys.push(options.apiKey);
      if (options.apiKeys) apiKeys.push(...options.apiKeys);
      if (config.apiKey) apiKeys.push(config.apiKey);
      apiKeys.push(...collectProviderApiKeys(provider));

      const uniqueKeys = [...new Set(apiKeys.filter((k) => k.length > 0))];
      if (uniqueKeys.length === 0) {
        const envVal = process.env[envKey];
        if (envVal) uniqueKeys.push(envVal);
      }

      async function runWithKey(apiKey: string): Promise<AgentRunResult> {
        const model = getModel(
          provider as Parameters<typeof getModel>[0],
          modelId as never,
        );

        const ctxInfo = resolveContextWindowInfo({
          modelContextWindow: model.contextWindow,
          configContextTokens: options.contextTokens,
        });
        const ctxGuard = evaluateContextWindowGuard({ info: ctxInfo });
        if (ctxGuard.shouldBlock) {
          throw new Error(
            `Context window too small (${ctxGuard.tokens} tokens). Minimum: ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
          );
        }

        const previousEnvValue = process.env[envKey];
        if (apiKey) process.env[envKey] = apiKey;

        try {
          const sessionManager = resolveSessionManager(
            SessionManager,
            workspaceDir,
            sessionsDir,
          );

          const memoryTools =
            config.memory?.enabled !== false
              ? (createMemoryTools(memory) as unknown as ToolDefinition[])
              : [];

          const customTools: ToolDefinition[] = [
            ...memoryTools,
            ...(options.tools ?? []),
          ];

          if (options.enableSubagents !== false) {
            const subTool = createSubagentTool({
              runtime: {
                run: (opts) => {
                  const subOpts = opts as unknown as AgentRunOptions;
                  return run({
                    ...subOpts,
                    systemPrompt: subOpts.systemPrompt ?? "You are a helpful sub-agent. Be concise and focused on the task.",
                  });
                },
              },
            });
            customTools.push(subTool as unknown as ToolDefinition);
          }

          const sessionOpts: CreateAgentSessionOptions = {
            cwd: workspaceDir,
            model,
            tools: [...codingTools],
            customTools,
            sessionManager,
          };

          return await retryAsync(
            async () => {
              const { session } = await createAgentSession(sessionOpts);

              const pendingToolArgs = new Map<
                string,
                Record<string, unknown>
              >();
              const unsubscribe = session.subscribe(
                (event: AgentSessionEvent) => {
                  options.onEvent?.(event);
                  if (event.type === "tool_execution_start") {
                    pendingToolArgs.set(
                      event.toolCallId,
                      (event.args as Record<string, unknown>) ?? {},
                    );
                    hooks
                      .run("before_tool_call", {
                        toolName: event.toolName,
                        input:
                          (event.args as Record<string, unknown>) ?? {},
                      })
                      .catch(() => {});
                  }
                  if (event.type === "tool_execution_end") {
                    const input =
                      pendingToolArgs.get(event.toolCallId) ?? {};
                    pendingToolArgs.delete(event.toolCallId);
                    hooks
                      .run("after_tool_call", {
                        toolName: event.toolName,
                        input,
                        result: event.result,
                      })
                      .catch(() => {});
                  }
                },
              );

              try {
                await session.sendUserMessage(options.message);
              } finally {
                unsubscribe();
              }

              const responseText = extractAssistantResponse(
                session.messages,
              );
              return {
                response: responseText,
                sessionId,
                provider,
                model: modelId,
              };
            },
            {
              attempts: options.maxRetries ?? 2,
              minDelayMs: 1000,
              maxDelayMs: 10_000,
              shouldRetry: (err) => {
                const msg =
                  err instanceof Error ? err.message : String(err);
                if (isLikelyContextOverflowError(msg)) {
                  log.warn("context overflow detected");
                  if (
                    config.memory?.enabled !== false &&
                    shouldRunMemoryFlush({
                      estimatedTokens: ctxInfo.tokens,
                      contextWindowTokens: ctxInfo.tokens,
                      sessionId,
                      state: memoryFlushState,
                    })
                  ) {
                    log.info("running pre-compaction memory flush");
                    markMemoryFlushed(memoryFlushState, sessionId);
                    run({
                      message: MEMORY_FLUSH_PROMPT,
                      sessionId,
                      model: modelId,
                      provider,
                      apiKey,
                      systemPrompt: MEMORY_FLUSH_SYSTEM_PROMPT,
                      enableSubagents: false,
                      maxRetries: 1,
                    }).catch((flushErr) => {
                      log.warn(`memory flush failed: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`);
                    });
                  }
                  return true;
                }
                return isRateLimitErrorMessage(msg) || isTimeoutErrorMessage(msg);
              },
              onRetry: ({ attempt, err }) => {
                log.warn(
                  `retry attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
            },
          );
        } finally {
          if (previousEnvValue === undefined) {
            delete process.env[envKey];
          } else {
            process.env[envKey] = previousEnvValue;
          }
        }
      }

      if (uniqueKeys.length > 1) {
        return executeWithApiKeyRotation({
          provider,
          apiKeys: uniqueKeys,
          execute: runWithKey,
        });
      }

      return runWithKey(uniqueKeys[0] ?? "");
    }

    const fallbackResult = await runWithModelFallback({
      provider: requestedProvider,
      model: requestedModelId,
      fallbacks: options.fallbacks,
      run: executeWithModel,
    });

    await hooks.run("after_agent_end", {
      sessionId,
      result: fallbackResult.result.response,
    });
    await hooks.run("session_end", { sessionId });

    await updateSession(stateDir, sessionId, {
      model: fallbackResult.model,
    });

    return {
      ...fallbackResult.result,
      fallbackUsed: fallbackResult.attempts.length > 0,
    };
  }

  return { run, hooks, memory, config };
}
