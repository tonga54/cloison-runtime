import * as path from "node:path";
import * as fs from "node:fs";
import * as url from "node:url";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { Writable } from "node:stream";
import type { HookRunner } from "../hooks/index.js";
import type { SimpleMemoryManager } from "../memory/index.js";
import type { SkillEnablement } from "../skills/enablement.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { CredentialStore } from "../credentials/types.js";
import type { WorkspaceConfig, WorkspaceRunOptions } from "./types.js";
import type { AgentRunResult } from "../runtime/index.js";
import type { SandboxConfig } from "../sandbox/types.js";
import type { WorkerConfig } from "../sandbox/worker.js";
import {
  getOrCreateSession,
  updateSession,
} from "../sessions/index.js";
import { createSandboxManager } from "../sandbox/manager.js";
import { createIpcPeer } from "../sandbox/ipc.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROTECTED_SYSTEM_ENV_KEYS,
  buildProviderEnvKey,
} from "../shared/index.js";
import { runWithModelFallback, createCooldownStore } from "../runtime/model-fallback.js";
import { resolveContextWindowInfo, evaluateContextWindowGuard, CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../runtime/context-guard.js";
import { collectProviderApiKeys, executeWithApiKeyRotation } from "../runtime/api-key-rotation.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("workspace-runner");

export interface WorkspaceRunnerOptions {
  userId: string;
  workspaceDir: string;
  config: WorkspaceConfig;
  hooks: HookRunner;
  memory: SimpleMemoryManager;
  skills: SkillEnablement;
  skillRegistry: SkillRegistry;
  credentials: CredentialStore;
}

export function createWorkspaceRunner(
  ctx: WorkspaceRunnerOptions,
): (options: WorkspaceRunOptions) => Promise<AgentRunResult> {

  const sandboxManager = createSandboxManager();
  const cooldownStore = createCooldownStore();

  return async function run(options: WorkspaceRunOptions): Promise<AgentRunResult> {
    const sessionId = options.sessionId ?? `session_${Date.now()}`;
    const requestedModelId = options.model ?? ctx.config.model ?? DEFAULT_MODEL;
    const requestedProvider = options.provider ?? ctx.config.provider ?? DEFAULT_PROVIDER;

    const sessionsDir = path.join(ctx.workspaceDir, "sessions", sessionId);
    fs.mkdirSync(sessionsDir, { recursive: true });

    await getOrCreateSession(ctx.workspaceDir, sessionId, { model: requestedModelId });

    await ctx.hooks.run("session_start", { sessionId });
    await ctx.hooks.run("before_agent_start", {
      sessionId,
      message: options.message,
      model: requestedModelId,
    });

    let skillsPrompt = "";
    if (ctx.config.skills?.enabled !== false) {
      const enabledIds = ctx.skills.listEnabledIds();
      if (enabledIds.length > 0) {
        try {
          const snapshot = ctx.skillRegistry.loadSkills(enabledIds);
          skillsPrompt = snapshot.promptText;
        } catch {
          // skills loading is optional
        }
      }
    }

    const systemPrompt = [
      options.systemPrompt ?? ctx.config.systemPrompt ?? "",
      skillsPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");

    async function executeWithModel(
      provider: string,
      modelId: string,
    ): Promise<AgentRunResult> {
      // Context window guard — same check as single-user runtime
      const ctxInfo = resolveContextWindowInfo({
        configContextTokens: (options as Record<string, unknown>).contextTokens as number | undefined,
      });
      const ctxGuard = evaluateContextWindowGuard({ info: ctxInfo });
      if (ctxGuard.shouldBlock) {
        throw new Error(
          `Context window too small (${ctxGuard.tokens} tokens). Minimum: ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
        );
      }

      const providerEnvKey = buildProviderEnvKey(provider);

      const apiKeys: string[] = [];
      if (options.apiKey) apiKeys.push(options.apiKey);
      if ((options as Record<string, unknown>).apiKeys) {
        apiKeys.push(...((options as Record<string, unknown>).apiKeys as string[]));
      }
      if (ctx.config.apiKey) apiKeys.push(ctx.config.apiKey);
      apiKeys.push(...collectProviderApiKeys(provider));
      const uniqueKeys = [...new Set(apiKeys.filter((k) => k.length > 0))];
      if (uniqueKeys.length === 0) {
        const envVal = process.env[providerEnvKey];
        if (envVal) uniqueKeys.push(envVal);
      }

      async function runWithKey(apiKey: string): Promise<AgentRunResult> {
        const workerConfig: WorkerConfig = {
          workspaceDir: ctx.workspaceDir,
          sessionsDir,
          sessionId,
          message: options.message,
          model: modelId,
          provider,
          systemPrompt: systemPrompt || undefined,
          enableCodingTools: true,
          contextTokens: (options as Record<string, unknown>).contextTokens as number | undefined,
          maxRetries: (options as Record<string, unknown>).maxRetries as number | undefined,
          enableSubagents: (options as Record<string, unknown>).enableSubagents as boolean | undefined,
        };

        const workerPath = resolveWorkerPath();
        const projectDir = path.dirname(path.dirname(workerPath));

        const workerConfigJson = JSON.stringify(workerConfig);
        const MAX_ENV_SIZE = 128 * 1024;
        if (workerConfigJson.length > MAX_ENV_SIZE) {
          throw new Error(
            `SANDBOX_WORKER_CONFIG exceeds ${MAX_ENV_SIZE} bytes (${workerConfigJson.length} bytes). ` +
            `Reduce the message or systemPrompt size.`,
          );
        }

        const workerEnv: Record<string, string> = {
          SANDBOX_WORKER_CONFIG: workerConfigJson,
        };
        if (apiKey) {
          workerEnv[providerEnvKey] = apiKey;
        }

        const sandboxConfig: SandboxConfig = {
          memoryLimitMb: 512,
          pidsLimit: 100,
          timeoutMs: 5 * 60 * 1000,
          networkIsolation: true,
          mountBinds: [
            { source: projectDir, target: projectDir, readonly: true },
          ],
        };

        const workerArgs = [
          "--experimental-vm-modules",
          "--no-warnings",
        ];
        if (workerPath.endsWith(".ts")) {
          workerArgs.push("--import", "tsx");
        }
        workerArgs.push(workerPath);

        const sandboxProcess = await sandboxManager.spawn({
          command: process.execPath,
          args: workerArgs,
          env: workerEnv,
          cwd: ctx.workspaceDir,
          config: sandboxConfig,
          protectedKeys: apiKey ? [providerEnvKey] : [],
          onStderr: (data) => {
            process.stderr.write(`[sandbox:${ctx.userId}] ${data}`);
          },
        });

        const agentTimeoutMs = (sandboxConfig.timeoutMs ?? 5 * 60 * 1000) + 60_000;
        const hostPeer = createIpcPeer(
          sandboxProcess.stdout as unknown as Readable,
          sandboxProcess.stdin as unknown as Writable,
          { callTimeoutMs: agentTimeoutMs },
        );

    const ipcRateLimiter = createIpcRateLimiter();

    hostPeer.handle("memory.search", async (params) => {
      ipcRateLimiter.check("memory.search");
      const p = params as Record<string, unknown> | undefined;
      const query = p?.query;
      if (typeof query !== "string" || query.length === 0) {
        throw new Error("memory.search: 'query' must be a non-empty string");
      }
      if (query.length > 10_000) {
        throw new Error("memory.search: 'query' exceeds maximum length (10000)");
      }
      const maxResults = typeof p?.maxResults === "number"
        ? Math.min(Math.max(1, Math.floor(p.maxResults)), 100)
        : undefined;
      return ctx.memory.search(query, { maxResults });
    });

    hostPeer.handle("memory.store", async (params) => {
      ipcRateLimiter.check("memory.store");
      const p = params as Record<string, unknown> | undefined;
      const content = p?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("memory.store: 'content' must be a non-empty string");
      }
      if (content.length > 1_000_000) {
        throw new Error("memory.store: 'content' exceeds maximum length (1000000)");
      }
      const metadata = p?.metadata as Record<string, unknown> | undefined;
      if (metadata !== undefined) {
        const metaStr = JSON.stringify(metadata);
        if (metaStr.length > 10_000) {
          throw new Error("memory.store: 'metadata' exceeds maximum serialized size (10000 bytes)");
        }
      }
      const id = await ctx.memory.store(content, metadata);
      return { id };
    });

    hostPeer.handle("skill.execute", async (params) => {
      ipcRateLimiter.check("skill.execute");
      const p = params as Record<string, unknown> | undefined;
      const skillId = p?.skillId;
      if (typeof skillId !== "string" || skillId.length === 0) {
        throw new Error("skill.execute: 'skillId' must be a non-empty string");
      }
      if (!ctx.skills.isEnabled(skillId)) {
        throw new Error(`Skill "${skillId}" is not enabled for this workspace`);
      }
      const skillEntry = ctx.skillRegistry.get(skillId);
      if (!skillEntry) {
        throw new Error(`Skill "${skillId}" not found in registry`);
      }

      const execScript = findSkillExecutable(skillEntry.path);
      if (!execScript) {
        throw new Error(
          `Skill "${skillId}" has no executable script. ` +
          `Add execute.js, execute.mjs, or execute.sh to the skill directory.`,
        );
      }

      const resolvedScript = path.resolve(execScript);
      const resolvedSkillDir = path.resolve(skillEntry.path);
      if (!resolvedScript.startsWith(resolvedSkillDir + path.sep)) {
        throw new Error(`Skill script "${execScript}" resolves outside skill directory`);
      }

      const credentials = await ctx.credentials.resolve(skillId) ?? {};
      const execParams = (p?.params ?? {}) as Record<string, unknown>;
      const result = await executeSkillScript(execScript, execParams, credentials, resolvedSkillDir);
      return { result };
    });

    hostPeer.handle("hooks.before_tool_call", async (params) => {
      ipcRateLimiter.check("hooks.before_tool_call");
      const p = params as Record<string, unknown> | undefined;
      const toolName = typeof p?.toolName === "string" ? p.toolName : "unknown";
      const input = (p?.input && typeof p.input === "object") ? p.input as Record<string, unknown> : {};
      await ctx.hooks.run("before_tool_call", { toolName, input });
      return {};
    });

    hostPeer.handle("hooks.after_tool_call", async (params) => {
      ipcRateLimiter.check("hooks.after_tool_call");
      const p = params as Record<string, unknown> | undefined;
      const toolName = typeof p?.toolName === "string" ? p.toolName : "unknown";
      const input = (p?.input && typeof p.input === "object") ? p.input as Record<string, unknown> : {};
      await ctx.hooks.run("after_tool_call", { toolName, input, result: p?.result });
      return {};
    });

    const onEvent = (options as Record<string, unknown>).onEvent as
      | ((event: Record<string, unknown>) => void)
      | undefined;
    if (onEvent) {
      hostPeer.handle("agent.event", async (params) => {
        const event = (params ?? {}) as Record<string, unknown>;
        try { onEvent(event); } catch { /* caller error */ }
        return {};
      });
    }

    hostPeer.start();

    // If the child process dies, stop the IPC peer so pending calls reject
    // instead of hanging forever. This prevents a deadlock where
    // hostPeer.call() awaits a response that will never come.
    sandboxProcess.waitForExit().then(
      () => hostPeer.stop(),
      () => hostPeer.stop(),
    );

    let result: AgentRunResult;

    try {
      const response = await hostPeer.call<{
        response?: string;
        sessionId?: string;
        error?: string;
      }>("agent.run", {
        message: options.message,
        sessionId,
        model: modelId,
        provider,
        systemPrompt: systemPrompt || undefined,
      });

      if (response.error) {
        throw new Error(`Agent execution failed: ${response.error}`);
      }

      result = {
        response: response.response ?? "",
        sessionId: response.sessionId ?? sessionId,
      };
    } catch (err) {
      hostPeer.stop();
      sandboxProcess.kill();
      await sandboxProcess.waitForExit();
      throw err;
    }

        hostPeer.stop();
        sandboxProcess.kill();
        await sandboxProcess.waitForExit();

        return {
          ...result,
          provider,
          model: modelId,
        };
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
      fallbacks: (options as Record<string, unknown>).fallbacks as string[] | undefined,
      run: executeWithModel,
      cooldownStore,
    });

    await ctx.hooks.run("after_agent_end", {
      sessionId,
      result: fallbackResult.result.response,
    });
    await ctx.hooks.run("session_end", { sessionId });

    await updateSession(ctx.workspaceDir, sessionId, { model: fallbackResult.model });

    return {
      ...fallbackResult.result,
      fallbackUsed: fallbackResult.attempts.length > 0,
    };
  };
}

function resolveWorkerPath(): string {
  const thisFile = url.fileURLToPath(import.meta.url);
  const srcDir = path.dirname(path.dirname(thisFile));
  const jsPath = path.join(srcDir, "sandbox", "worker.js");
  if (fs.existsSync(jsPath)) return jsPath;
  const tsPath = path.join(srcDir, "sandbox", "worker.ts");
  if (fs.existsSync(tsPath)) return tsPath;
  return jsPath;
}

function findSkillExecutable(skillDir: string): string | undefined {
  for (const name of ["execute.js", "execute.mjs", "execute.sh"]) {
    const full = path.join(skillDir, name);
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

const MAX_SKILL_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

async function executeSkillScript(
  scriptPath: string,
  params: Record<string, unknown>,
  credentials: Record<string, string>,
  cwd: string,
  timeoutMs = 30_000,
): Promise<string> {
  const ext = path.extname(scriptPath);
  let command: string;
  let args: string[];

  switch (ext) {
    case ".js":
    case ".mjs":
      command = process.execPath;
      args = ["--no-warnings", scriptPath];
      break;
    case ".sh":
      command = "/bin/bash";
      args = [scriptPath];
      break;
    default:
      throw new Error(`Unsupported skill script type: ${ext}`);
  }

  const env: Record<string, string> = {};
  for (const key of PROTECTED_SYSTEM_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  for (const [key, value] of Object.entries(credentials)) {
    if (PROTECTED_SYSTEM_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    let outputLimitExceeded = false;

    child.stdout.on("data", (data: Buffer) => {
      if (outputLimitExceeded) return;
      stdout += data.toString();
      if (stdout.length > MAX_SKILL_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      if (outputLimitExceeded) return;
      stderr += data.toString();
      if (stderr.length > MAX_SKILL_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    });

    child.on("close", (code) => {
      if (outputLimitExceeded) {
        reject(new Error(`Skill script output exceeded ${MAX_SKILL_OUTPUT_BYTES} bytes limit`));
      } else if (code !== 0) {
        reject(new Error(`Skill script exited with code ${code}: ${stderr.slice(0, 1000)}`));
      } else {
        resolve(stdout);
      }
    });

    child.on("error", reject);

    child.stdin.write(JSON.stringify(params));
    child.stdin.end();
  });
}

const IPC_RATE_LIMIT = 200;
const IPC_RATE_WINDOW_MS = 1000;

function createIpcRateLimiter() {
  const counters = new Map<string, { count: number; resetAt: number }>();

  return {
    check(method: string): void {
      const now = Date.now();
      let entry = counters.get(method);
      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + IPC_RATE_WINDOW_MS };
        counters.set(method, entry);
      }
      entry.count++;
      if (entry.count > IPC_RATE_LIMIT) {
        throw new Error(
          `IPC rate limit exceeded for "${method}": max ${IPC_RATE_LIMIT} calls per ${IPC_RATE_WINDOW_MS}ms`,
        );
      }
    },
  };
}
