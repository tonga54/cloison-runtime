/**
 * Demo: Subagents
 *
 * Shows:
 * - Orchestrator delegates tasks to specialist subagents
 * - Each subagent has its own session, system prompt, and context
 * - Parent waits for subagent completion before continuing
 * - All sessions are tracked in the shared session store
 *
 * Run: npx tsx demos/demo-subagents.ts
 */
import { initRuntime, cleanState } from "./_shared.js";
import { loadSessionStore } from "../src/sessions/index.js";

async function main() {
  cleanState();

  const runtime = await initRuntime({ stateDir: ".cloison-runtime-demo" });

  const subagentLog: { role: string; question: string; answer: string }[] = [];

  const askSpecialist = {
    name: "ask_specialist",
    description: "Delegate a question to a specialist sub-agent with its own session.",
    parameters: {
      type: "object" as const,
      properties: {
        role: { type: "string", description: "Specialist role (e.g. 'historian', 'chemist')" },
        question: { type: "string", description: "The question to ask" },
      },
      required: ["role", "question"],
    },
    async execute(_toolCallId: string, params: { role: string; question: string }) {
      const sessionId = `specialist-${params.role}-${Date.now()}`;
      console.log(`\n    >> Spawning [${params.role}]: "${params.question}"`);

      const result = await runtime.run({
        message: params.question,
        sessionId,
        systemPrompt: `You are a ${params.role}. Give a precise, concise answer (1-2 sentences max).`,
      });

      console.log(`    << [${params.role}] replied: "${result.response}"`);
      subagentLog.push({ role: params.role, question: params.question, answer: result.response });

      return { content: [{ type: "text" as const, text: result.response }], details: {} };
    },
  };

  // --- Scenario 1: Multi-domain ---
  console.log("=== Scenario 1: Multi-domain delegation ===\n");
  console.log("  Orchestrator receives a multi-part question...\n");

  const r1 = await runtime.run({
    message: [
      "Answer these three questions using the ask_specialist tool:",
      "1. What year did the French Revolution start?",
      "2. What is the chemical formula for water?",
      "3. How many legs does a spider have?",
    ].join("\n"),
    sessionId: "orchestrator-1",
    systemPrompt: "You are an orchestrator. Use ask_specialist for each question with appropriate roles. Then compile all answers.",
    tools: [askSpecialist],
  });

  console.log(`\n  [orchestrator-1] Final:\n    ${r1.response.replace(/\n/g, "\n    ")}`);

  // --- Scenario 2: Chained ---
  console.log("\n=== Scenario 2: Chained reasoning ===\n");

  const r2 = await runtime.run({
    message: "A train travels at 120 km/h for 2.5 hours. How far? Use ask_specialist with role 'mathematician'.",
    sessionId: "orchestrator-2",
    systemPrompt: "You are an orchestrator. Delegate calculations to specialists. Report the final answer.",
    tools: [askSpecialist],
  });

  console.log(`\n  [orchestrator-2] Final: ${r2.response}`);

  // --- Summary ---
  console.log("\n=== Subagent activity log ===\n");
  for (const e of subagentLog) {
    console.log(`  [${e.role}] Q: "${e.question}"`);
    console.log(`  ${" ".repeat(e.role.length + 3)}A: "${e.answer}"\n`);
  }

  console.log("=== All sessions ===\n");
  const store = loadSessionStore(".cloison-runtime-demo");
  const sessions = Object.values(store.entries)
    .filter((e) => e.id.startsWith("orchestrator") || e.id.startsWith("specialist"))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const s of sessions) {
    const isChild = s.id.startsWith("specialist");
    console.log(`${isChild ? "    " : "  "}[${isChild ? "child" : "parent"}] ${s.id}`);
  }

  cleanState();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
