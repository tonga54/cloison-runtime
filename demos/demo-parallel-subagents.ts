/**
 * Demo: Parallel subagent execution
 *
 * Shows:
 * - spawnSubagentsParallel() with controlled concurrency
 * - Subagent lifecycle events (completed, error, timeout)
 * - SubagentRegistry for tracking run state
 * - Depth limiting (max 5 levels of nesting)
 * - Run timeout enforcement
 * - onResult callback for real-time tracking
 *
 * Run: npx tsx demos/demo-parallel-subagents.ts
 * Note: No API key needed — uses simulated tasks.
 */
import {
  spawnSubagentsParallel,
  createSubagentRegistry,
  type SubagentTask,
  type SubagentResult,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "../src/runtime/subagent.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== Parallel Subagent Execution Demo ===\n");

  // --- Basic parallel execution ---
  console.log("--- Scenario 1: 5 tasks, maxConcurrent=3 ---\n");

  let activeCount = 0;
  let peakConcurrency = 0;

  const results1 = await spawnSubagentsParallel({
    tasks: [
      { id: "research", task: "Research market trends", label: "Market Research" },
      { id: "analysis", task: "Analyze competitor pricing", label: "Competitor Analysis" },
      { id: "report", task: "Draft executive summary", label: "Report Draft" },
      { id: "review", task: "Review legal compliance", label: "Legal Review" },
      { id: "forecast", task: "Build financial forecast", label: "Financial Forecast" },
    ],
    maxConcurrent: 3,
    run: async (task) => {
      activeCount++;
      peakConcurrency = Math.max(peakConcurrency, activeCount);
      const duration = 50 + Math.random() * 100;
      await sleep(duration);
      activeCount--;
      return `Completed: ${task.label} (${Math.round(duration)}ms)`;
    },
    onResult: (result) => {
      const label = result.id.padEnd(12);
      console.log(`  [${result.status}] ${label} ${result.durationMs}ms`);
    },
  });

  console.log(`\n  Total results: ${results1.length}`);
  console.log(`  Peak concurrency: ${peakConcurrency} (limit: 3)`);
  console.log(`  All completed: ${results1.every((r) => r.status === "completed")}`);

  // --- Mixed success/failure ---
  console.log("\n--- Scenario 2: Mixed results (success + error + timeout) ---\n");

  const results2 = await spawnSubagentsParallel({
    tasks: [
      { id: "ok-1", task: "Succeeds quickly", label: "Fast Task" },
      { id: "ok-2", task: "Succeeds slowly", label: "Slow Task" },
      { id: "fail", task: "Throws an error", label: "Error Task" },
    ],
    run: async (task) => {
      if (task.id === "fail") {
        await sleep(30);
        throw new Error("API rate limit exceeded");
      }
      await sleep(task.id === "ok-2" ? 100 : 20);
      return `Done: ${task.label}`;
    },
    onResult: (result) => {
      const icon = result.status === "completed" ? "✓" : result.status === "timeout" ? "⏰" : "✗";
      console.log(`  ${icon} [${result.id}] ${result.status} — ${result.error ?? result.response?.slice(0, 40)}`);
    },
  });

  const completed = results2.filter((r) => r.status === "completed").length;
  const failed = results2.filter((r) => r.status === "error").length;
  console.log(`\n  Completed: ${completed}, Failed: ${failed}`);

  // --- Run timeout ---
  console.log("\n--- Scenario 3: Run timeout ---\n");

  const results3 = await spawnSubagentsParallel({
    tasks: [
      { id: "fast", task: "Finishes in 20ms" },
      { id: "slow", task: "Takes 500ms (will timeout)" },
    ],
    runTimeoutMs: 100,
    run: async (task) => {
      const duration = task.id === "slow" ? 500 : 20;
      await sleep(duration);
      return `Done in ${duration}ms`;
    },
    onResult: (result) => {
      console.log(`  [${result.id}] ${result.status} — ${result.error ?? result.response}`);
    },
  });

  console.log(`\n  Timed out: ${results3.filter((r) => r.status === "timeout").length}`);

  // --- Registry tracking ---
  console.log("\n--- Scenario 4: SubagentRegistry ---\n");

  const registry = createSubagentRegistry();
  registry.register({ id: "r1", task: "task A", status: "running", startedAt: Date.now() });
  registry.register({ id: "r2", task: "task B", status: "pending", startedAt: Date.now() });
  registry.register({ id: "r3", task: "task C", status: "completed", startedAt: Date.now() - 5000 });

  console.log(`  Total runs: ${registry.listAll().length}`);
  console.log(`  Active runs: ${registry.countActive()}`);
  console.log(`  Active IDs: ${registry.listActive().map((r) => r.id).join(", ")}`);

  registry.update("r1", {
    status: "completed",
    endedAt: Date.now(),
    endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
    outcome: { status: "ok" },
  });
  registry.update("r2", {
    status: "error",
    endedAt: Date.now(),
    endedReason: SUBAGENT_ENDED_REASON_ERROR,
    outcome: { status: "error", error: "rate limit" },
  });

  console.log(`  After updates — active: ${registry.countActive()}`);
  for (const run of registry.listAll()) {
    console.log(`    [${run.id}] ${run.status} ${run.endedReason ?? ""}`);
  }

  // --- Depth limiting ---
  console.log("\n--- Scenario 5: Depth limiting ---\n");
  try {
    await spawnSubagentsParallel({
      tasks: [{ id: "deep", task: "too deep" }],
      currentDepth: 5,
      run: async () => "should not run",
    });
  } catch (err) {
    console.log(`  Depth 5: ${(err as Error).message}`);
  }

  // --- Lifecycle constants ---
  console.log("\n--- Lifecycle constants ---\n");
  console.log(`  COMPLETE: "${SUBAGENT_ENDED_REASON_COMPLETE}"`);
  console.log(`  ERROR:    "${SUBAGENT_ENDED_REASON_ERROR}"`);
  console.log(`  KILLED:   "${SUBAGENT_ENDED_REASON_KILLED}"`);

  console.log("\nDemo complete.");
}

main().catch(console.error);
