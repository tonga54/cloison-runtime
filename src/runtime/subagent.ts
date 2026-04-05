// Ported from OpenClaw src/agents/subagent-*.ts
// Kept: registry, parallel execution, lifecycle events, depth limiting
// Removed: gateway RPC, announce flow, thread binding, orphan recovery

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("subagent");

// --- Lifecycle events (from subagent-lifecycle-events.ts) ---

export const SUBAGENT_ENDED_REASON_COMPLETE = "subagent-complete" as const;
export const SUBAGENT_ENDED_REASON_ERROR = "subagent-error" as const;
export const SUBAGENT_ENDED_REASON_KILLED = "subagent-killed" as const;

export type SubagentLifecycleEndedReason =
  | typeof SUBAGENT_ENDED_REASON_COMPLETE
  | typeof SUBAGENT_ENDED_REASON_ERROR
  | typeof SUBAGENT_ENDED_REASON_KILLED;

export const SUBAGENT_ENDED_OUTCOME_OK = "ok" as const;
export const SUBAGENT_ENDED_OUTCOME_ERROR = "error" as const;
export const SUBAGENT_ENDED_OUTCOME_TIMEOUT = "timeout" as const;
export const SUBAGENT_ENDED_OUTCOME_KILLED = "killed" as const;

export type SubagentLifecycleEndedOutcome =
  | typeof SUBAGENT_ENDED_OUTCOME_OK
  | typeof SUBAGENT_ENDED_OUTCOME_ERROR
  | typeof SUBAGENT_ENDED_OUTCOME_TIMEOUT
  | typeof SUBAGENT_ENDED_OUTCOME_KILLED;

// --- Constants ---

const MAX_SUBAGENT_DEPTH = 5;
const DEFAULT_MAX_CONCURRENT = 10;

// --- Types ---

export interface SubagentTask {
  id: string;
  task: string;
  label?: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
}

export interface SubagentResult {
  id: string;
  status: "completed" | "error" | "timeout";
  response?: string;
  error?: string;
  durationMs: number;
}

export type SubagentRunOutcome =
  | { status: "ok" }
  | { status: "error"; error?: string }
  | { status: "timeout" };

export interface SubagentRunRecord {
  id: string;
  task: string;
  label?: string;
  model?: string;
  status: "pending" | "running" | "completed" | "error";
  startedAt: number;
  endedAt?: number;
  sessionStartedAt?: number;
  response?: string;
  error?: string;
  endedReason?: SubagentLifecycleEndedReason;
  outcome?: SubagentRunOutcome;
  cleanup?: "delete" | "keep";
  runTimeoutMs?: number;
}

// --- Registry (from subagent-registry-memory.ts + registry.ts) ---

export interface SubagentRegistry {
  register(record: SubagentRunRecord): void;
  update(id: string, updates: Partial<SubagentRunRecord>): void;
  get(id: string): SubagentRunRecord | undefined;
  listActive(): SubagentRunRecord[];
  listAll(): SubagentRunRecord[];
  countActive(): number;
  clear(): void;
}

export function createSubagentRegistry(): SubagentRegistry {
  const runs = new Map<string, SubagentRunRecord>();

  return {
    register(record) {
      runs.set(record.id, { ...record });
      log.debug(`registered subagent ${record.id}`, { task: record.task.slice(0, 100) });
    },
    update(id, updates) {
      const existing = runs.get(id);
      if (existing) Object.assign(existing, updates);
    },
    get(id) { return runs.get(id); },
    listActive() {
      return Array.from(runs.values()).filter((r) => r.status === "pending" || r.status === "running");
    },
    listAll() { return Array.from(runs.values()); },
    countActive() {
      let count = 0;
      for (const r of runs.values()) {
        if (r.status === "pending" || r.status === "running") count++;
      }
      return count;
    },
    clear() { runs.clear(); },
  };
}

// --- Parallel execution ---

export interface SubagentSpawnOptions {
  tasks: SubagentTask[];
  run: (task: SubagentTask) => Promise<string>;
  maxConcurrent?: number;
  currentDepth?: number;
  onResult?: (result: SubagentResult) => void;
  runTimeoutMs?: number;
}

export async function spawnSubagentsParallel(
  options: SubagentSpawnOptions,
): Promise<SubagentResult[]> {
  const {
    tasks, run, maxConcurrent = DEFAULT_MAX_CONCURRENT,
    currentDepth = 0, onResult, runTimeoutMs,
  } = options;

  if (currentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(`Subagent depth limit exceeded (max: ${MAX_SUBAGENT_DEPTH}). Prevent infinite recursion by reducing nesting.`);
  }
  if (tasks.length === 0) return [];

  log.info(`spawning ${tasks.length} subagents (depth: ${currentDepth})`, {
    labels: tasks.map((t) => t.label ?? t.id),
  });

  const registry = createSubagentRegistry();
  for (const task of tasks) {
    registry.register({
      id: task.id,
      task: task.task,
      label: task.label,
      model: task.model,
      status: "pending",
      startedAt: Date.now(),
      cleanup: "delete",
      runTimeoutMs,
    });
  }

  async function runTask(task: SubagentTask): Promise<SubagentResult> {
    registry.update(task.id, { status: "running", sessionStartedAt: Date.now() });
    const startMs = Date.now();

    try {
      let resultPromise = run(task);
      if (runTimeoutMs && runTimeoutMs > 0) {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Subagent ${task.id} timed out after ${runTimeoutMs}ms`)), runTimeoutMs),
        );
        resultPromise = Promise.race([resultPromise, timeoutPromise]) as Promise<string>;
      }

      const response = await resultPromise;
      const result: SubagentResult = {
        id: task.id, status: "completed", response, durationMs: Date.now() - startMs,
      };
      registry.update(task.id, {
        status: "completed", endedAt: Date.now(), response,
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        outcome: { status: "ok" },
      });
      log.info(`subagent ${task.id} completed in ${result.durationMs}ms`);
      onResult?.(result);
      return result;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes("timed out");
      const result: SubagentResult = {
        id: task.id,
        status: isTimeout ? "timeout" : "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      };
      registry.update(task.id, {
        status: "error", endedAt: Date.now(), error: result.error,
        endedReason: isTimeout ? SUBAGENT_ENDED_REASON_KILLED : SUBAGENT_ENDED_REASON_ERROR,
        outcome: isTimeout ? { status: "timeout" } : { status: "error", error: result.error },
      });
      log.error(`subagent ${task.id} failed: ${result.error}`);
      onResult?.(result);
      return result;
    }
  }

  const concurrency = Math.min(maxConcurrent, tasks.length);

  if (concurrency >= tasks.length) {
    return await Promise.all(tasks.map(runTask));
  }

  let taskIndex = 0;
  const allResults: SubagentResult[] = [];

  async function worker(): Promise<void> {
    while (taskIndex < tasks.length) {
      const idx = taskIndex++;
      const result = await runTask(tasks[idx]);
      allResults.push(result);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return allResults;
}

// --- Agent-facing tool ---

export function createSubagentTool(params: {
  runtime: { run: (opts: Record<string, unknown>) => Promise<{ response: string }> };
  currentDepth?: number;
}): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, toolParams: Record<string, unknown>) => Promise<{ resultForAssistant: string }>;
} {
  const depth = params.currentDepth ?? 0;

  return {
    name: "subagent_spawn",
    description:
      "Spawn one or more sub-agents to handle tasks in parallel. " +
      "Each sub-agent runs independently and returns its result. " +
      "Use for parallel or complex work that can be decomposed into subtasks.",
    parameters: {
      type: "Object",
      properties: {
        tasks: {
          type: "Array",
          description: "Array of tasks to execute in parallel",
          items: {
            type: "Object",
            properties: {
              task: { type: "String", description: "The task message for the sub-agent" },
              label: { type: "String", description: "Optional label for tracking" },
              role: { type: "String", description: "Optional role/expertise for the sub-agent system prompt" },
            },
            required: ["task"],
          },
        },
      },
      required: ["tasks"],
    },

    async execute(_toolCallId, toolParams) {
      const rawTasks = toolParams.tasks as Array<{ task: string; label?: string; role?: string }> | undefined;
      if (!rawTasks || !Array.isArray(rawTasks) || rawTasks.length === 0) {
        return { resultForAssistant: "Error: 'tasks' must be a non-empty array" };
      }

      const subTasks: SubagentTask[] = rawTasks.map((t, i) => ({
        id: `sub_${Date.now()}_${i}`,
        task: t.task,
        label: t.label,
        systemPrompt: t.role ? `You are a ${t.role} expert.` : undefined,
      }));

      try {
        const results = await spawnSubagentsParallel({
          tasks: subTasks,
          currentDepth: depth + 1,
          run: async (task) => {
            const r = await params.runtime.run({ message: task.task, systemPrompt: task.systemPrompt });
            return r.response;
          },
        });

        const summary = results.map((r) => ({
          id: r.id,
          label: subTasks.find((t) => t.id === r.id)?.label,
          status: r.status,
          response: r.response?.slice(0, 2000),
          error: r.error,
          durationMs: r.durationMs,
        }));

        return { resultForAssistant: JSON.stringify(summary, null, 2) };
      } catch (err) {
        return { resultForAssistant: `Error spawning subagents: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
