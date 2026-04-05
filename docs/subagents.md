# Subagent Orchestration

Agents can spawn sub-agents for parallel or complex work. Sub-agents run concurrently with controlled parallelism and depth limiting.

## Automatic Subagents

When enabled, the agent gets a `subagent_spawn` tool it can use autonomously:

```typescript
const result = await runtime.run({
  message: "Review this PR for security and performance",
  enableSubagents: true,
});
```

The agent decides when to delegate work to specialists.

## Programmatic Subagents

```typescript
import { spawnSubagentsParallel } from "bulkhead-runtime";

const results = await spawnSubagentsParallel({
  tasks: [
    { id: "security", task: "Audit for SQL injection and XSS", label: "Security" },
    { id: "perf", task: "Profile hot paths and suggest optimizations", label: "Performance" },
    { id: "docs", task: "Check all public APIs have JSDoc", label: "Documentation" },
  ],
  maxConcurrent: 3,
  run: async (task) => {
    const r = await runtime.run({
      message: task.task,
      systemPrompt: `You are a ${task.label} expert.`,
    });
    return r.response;
  },
});
```

## Depth Limiting

Subagents can spawn their own subagents, up to a configurable depth limit (default: 5). This prevents infinite recursion.

## Registry

The subagent registry tracks all active and completed sub-agent runs:

```typescript
import { createSubagentRegistry } from "bulkhead-runtime";

const registry = createSubagentRegistry();
registry.listActive();   // Currently running
registry.listAll();      // All runs
registry.countActive();  // Number of active runs
```

## Timeout

Individual subagent runs can be time-limited:

```typescript
const results = await spawnSubagentsParallel({
  tasks: [...],
  run: myRunner,
  runTimeoutMs: 60_000, // 1 minute per subagent
});
```

## Source Files

- `src/runtime/subagent.ts` — Parallel execution, lifecycle, registry, depth limiting
