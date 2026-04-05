/**
 * Demo: Session management
 *
 * Shows:
 * - Named sessions (user-alice, user-bob)
 * - Auto-generated session IDs
 * - Specialized sessions with different system prompts
 * - Session store inspection
 * - Lifecycle hooks (before/after agent, session start/end)
 *
 * Run: npx tsx demos/demo-sessions.ts
 */
import { initRuntime, cleanState } from "./_shared.js";
import { loadSessionStore } from "../src/sessions/index.js";

async function main() {
  cleanState();

  const runtime = await initRuntime({
    stateDir: ".cloison-runtime-demo",
    systemPrompt: "You are a concise assistant. Reply in 1-2 sentences.",
  });

  // --- Named sessions ---
  console.log("=== Named sessions ===\n");

  const r1 = await runtime.run({
    message: "Remember this: my favorite color is blue.",
    sessionId: "user-alice",
  });
  console.log(`  [user-alice] ${r1.response}`);

  const r2 = await runtime.run({
    message: "What is 7 * 8?",
    sessionId: "user-bob",
  });
  console.log(`  [user-bob]   ${r2.response}`);

  // --- Auto-generated session IDs ---
  console.log("\n=== Auto-generated sessions ===\n");

  const r3 = await runtime.run({ message: "Name three planets." });
  console.log(`  [${r3.sessionId}] ${r3.response}`);

  const r4 = await runtime.run({ message: "Name three colors." });
  console.log(`  [${r4.sessionId}] ${r4.response}`);

  // --- Specialized sessions ---
  console.log("\n=== Specialized sessions ===\n");

  const r5 = await runtime.run({
    message: "Explain recursion in one sentence.",
    sessionId: "teacher",
    systemPrompt: "You are a patient computer science teacher.",
  });
  console.log(`  [teacher] ${r5.response}`);

  const r6 = await runtime.run({
    message: "Write a haiku about code.",
    sessionId: "poet",
    systemPrompt: "You are a minimalist poet. Only output the poem, nothing else.",
  });
  console.log(`  [poet] ${r6.response}`);

  // --- Inspect session store ---
  console.log("\n=== Session store ===\n");

  const store = loadSessionStore(".cloison-runtime-demo");
  const entries = Object.values(store.entries).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  console.log(`  Total sessions: ${entries.length}\n`);
  for (const entry of entries) {
    const age = Date.now() - new Date(entry.createdAt).getTime();
    const ageStr = age < 60_000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60_000)}m ago`;
    console.log(`  ${entry.id.padEnd(30)} model=${entry.model ?? "?"} created=${ageStr}`);
  }

  // --- Lifecycle hooks ---
  console.log("\n=== Lifecycle hooks ===\n");

  runtime.hooks.register("session_start", async (p) => {
    console.log(`  [hook] session_start: ${p.sessionId}`);
  });
  runtime.hooks.register("session_end", async (p) => {
    console.log(`  [hook] session_end:   ${p.sessionId}`);
  });
  runtime.hooks.register("before_agent_start", async (p) => {
    console.log(`  [hook] before_agent:  ${p.sessionId} (model=${p.model})`);
  });
  runtime.hooks.register("after_agent_end", async (p) => {
    console.log(`  [hook] after_agent:   ${p.sessionId} (${String(p.result).length} chars)`);
  });

  const r7 = await runtime.run({ message: "Say 'ping'.", sessionId: "hook-demo" });
  console.log(`  [hook-demo] ${r7.response}`);

  cleanState();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
