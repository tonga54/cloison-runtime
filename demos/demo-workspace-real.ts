/**
 * Demo: Real multi-tenant workspace with skills, memory, and agent execution
 *
 * Scenario: A DevOps AI platform serving two engineering teams.
 *
 * Team Alpha (SRE team):
 *   - Skills: deploy-status, calculator
 *   - Memory: infrastructure runbook, incident history
 *   - Agent answers ops questions using real context
 *
 * Team Beta (Backend team):
 *   - Skills: api-health, calculator
 *   - Memory: API docs, architecture decisions
 *   - Agent answers backend questions using real context
 *
 * Shows:
 *   - Platform + workspace lifecycle
 *   - Skill registration, enablement per tenant
 *   - Memory population and semantic recall
 *   - Agent execution with tools (memory + skills)
 *   - Credential isolation
 *   - Full tenant isolation (Alpha can't see Beta's data)
 *
 * Run: GEMINI_API_KEY=... CLOISON_CREDENTIAL_KEY=demo npx tsx demos/demo-workspace-real.ts
 */
import { createPlatform } from "../src/platform/index.js";
import { createRuntime, type AgentRunResult } from "../src/runtime/index.js";
import * as fs from "node:fs";
import * as path from "node:path";

const PROVIDER = process.env["CLOISON_PROVIDER"] ?? "google";
const MODEL = process.env["CLOISON_MODEL"] ?? "gemini-2.5-flash";
const STATE_DIR = path.join(import.meta.dirname, "..", ".workspace-demo");

fs.rmSync(STATE_DIR, { recursive: true, force: true });

async function main() {
  console.log("=== DevOps AI Platform — Multi-Tenant Demo ===\n");

  // ── 1. Create platform & register skills ──

  const platform = createPlatform({
    stateDir: STATE_DIR,
    credentialPassphrase: process.env["CLOISON_CREDENTIAL_KEY"] ?? "demo-key",
  });

  const skillsDir = path.join(import.meta.dirname, "skills");
  platform.skills.register(path.join(skillsDir, "deploy-status"));
  platform.skills.register(path.join(skillsDir, "api-health"));
  platform.skills.register(path.join(skillsDir, "calculator"));

  console.log("Registered skills:", platform.skills.list().map((s) => s.id).join(", "));

  // ── 2. Create workspaces ──

  const alpha = await platform.createWorkspace("team-alpha", {
    model: MODEL,
    provider: PROVIDER,
  });

  const beta = await platform.createWorkspace("team-beta", {
    model: MODEL,
    provider: PROVIDER,
  });

  // ── 3. Enable skills per tenant ──

  alpha.skills.enable("deploy-status");
  alpha.skills.enable("calculator");

  beta.skills.enable("api-health");
  beta.skills.enable("calculator");

  console.log("Team Alpha skills:", alpha.skills.listEnabledIds().join(", "));
  console.log("Team Beta skills:", beta.skills.listEnabledIds().join(", "));

  // ── 4. Store credentials (encrypted, isolated) ──

  await alpha.credentials.store("pagerduty", { apiKey: "pd-alpha-key-xxx", subdomain: "acme-sre" });
  await beta.credentials.store("datadog", { apiKey: "dd-beta-key-yyy", appKey: "dd-beta-app-zzz" });

  console.log("Team Alpha credentials:", (await alpha.credentials.list()).join(", "));
  console.log("Team Beta credentials:", (await beta.credentials.list()).join(", "));

  // ── 5. Populate memory per tenant ──

  console.log("\nPopulating team memories...");

  const alphaMemories = [
    "Our production stack runs on AWS EKS (Kubernetes 1.29) across us-east-1 and eu-west-1.",
    "The API gateway (Kong) sits behind CloudFront. Rate limits are 1000 req/s per tenant.",
    "Last major incident (2026-03-28): gateway OOM due to memory leak in auth plugin v2.3.1. Fixed in v2.3.2.",
    "Deployment pipeline: GitHub Actions → ECR → ArgoCD → EKS. Rollback is automatic on failed health checks.",
    "Database is Aurora PostgreSQL 16.2 with read replicas. Connection pooling via PgBouncer (max 200 connections).",
    "Alert escalation: PagerDuty → Slack #sre-alerts → on-call engineer. P1 response time SLA: 15 minutes.",
    "Redis cluster (ElastiCache r7g.xlarge) handles session cache and rate limiting. Current memory usage ~30%.",
    "The gateway has been showing intermittent OOMKilled restarts since the 2026-04-05 deploy of v2.4.0.",
  ];

  const betaMemories = [
    "Our API follows REST conventions with JSON:API spec. All endpoints versioned under /api/v1/.",
    "Authentication uses OAuth 2.0 with JWT tokens (RS256). Token expiry: 1 hour, refresh tokens: 30 days.",
    "The payments endpoint integrates with Stripe. Webhook signature verification is mandatory.",
    "Search is powered by Elasticsearch 8.x with custom analyzers for multi-language support.",
    "We decided to use event sourcing for the orders domain (ADR-042, 2026-02-15). Events stored in Kafka.",
    "Rate limiting: 100 req/min for free tier, 1000 req/min for pro, 10000 req/min for enterprise.",
    "The /api/v1/webhooks endpoint has been unreliable since March. Circuit breaker trips frequently.",
    "P99 latency target is 200ms for all endpoints. The payments endpoint currently exceeds this at 890ms.",
  ];

  for (const m of alphaMemories) await alpha.memory.store(m, { source: "runbook" });
  for (const m of betaMemories) await beta.memory.store(m, { source: "docs" });

  console.log(`  Team Alpha: ${alphaMemories.length} memories stored`);
  console.log(`  Team Beta: ${betaMemories.length} memories stored`);

  // ── 6. Create runtimes with tenant context ──

  const alphaRuntime = await createRuntime({
    provider: PROVIDER,
    model: MODEL,
    skills: { enabled: false },
    stateDir: path.join(STATE_DIR, "workspaces", "team-alpha"),
  });

  const betaRuntime = await createRuntime({
    provider: PROVIDER,
    model: MODEL,
    skills: { enabled: false },
    stateDir: path.join(STATE_DIR, "workspaces", "team-beta"),
  });

  // ── 7. Build skill tools per tenant ──

  function createSkillTool(skillId: string, skillDir: string) {
    const skillMd = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
    const description = skillMd.split("\n").filter((l) => l.trim() && !l.startsWith("#")).join(" ").slice(0, 200);

    return {
      name: `skill_${skillId}`,
      description: `[Skill: ${skillId}] ${description}`,
      parameters: {
        type: "object" as const,
        properties: {
          params: {
            type: "object" as const,
            description: "Parameters to pass to the skill (JSON object)",
          },
        },
      },
      async execute(_toolCallId: string, toolParams: Record<string, unknown>) {
        const execPath = path.join(skillDir, "execute.js");
        const { execFileSync } = await import("node:child_process");
        const input = JSON.stringify(toolParams.params ?? {});
        const output = execFileSync(process.execPath, [execPath], {
          input,
          encoding: "utf-8",
          timeout: 10_000,
        });
        return { content: [{ type: "text" as const, text: output }], details: {} };
      },
    };
  }

  const alphaTools = alpha.skills.listEnabledIds().map((id) => {
    const entry = platform.skills.get(id)!;
    return createSkillTool(id, entry.path);
  });

  const betaTools = beta.skills.listEnabledIds().map((id) => {
    const entry = platform.skills.get(id)!;
    return createSkillTool(id, entry.path);
  });

  // ── 8. Run agents ──

  async function askAgent(
    label: string,
    runtime: typeof alphaRuntime,
    memory: typeof alpha.memory,
    tools: typeof alphaTools,
    question: string,
  ): Promise<AgentRunResult> {
    console.log(`\n[${ label}] Q: "${question}"`);

    const recalls = await memory.search(question, { maxResults: 3 });
    const context = recalls.length > 0
      ? "\n\nRelevant context from your knowledge base:\n" +
        recalls.map((r) => `- ${r.snippet}`).join("\n")
      : "";

    const result = await runtime.run({
      message: question + context,
      sessionId: `${label}-${Date.now()}`,
      systemPrompt:
        `You are a DevOps AI assistant for ${label}. ` +
        "Use your available skills (tools) to fetch live data when relevant. " +
        "Combine skill results with your knowledge base context to give actionable answers. " +
        "Be concise — 2-4 sentences max.",
      tools,
    });

    console.log(`[${label}] A: ${result.response}\n`);
    return result;
  }

  // --- Team Alpha scenarios ---

  console.log("\n" + "=".repeat(60));
  console.log("  TEAM ALPHA (SRE) — Infrastructure & Operations");
  console.log("=".repeat(60));

  await askAgent(
    "team-alpha", alphaRuntime, alpha.memory, alphaTools,
    "The gateway is acting up again. What's the current deploy status and what happened last time?",
  );

  await askAgent(
    "team-alpha", alphaRuntime, alpha.memory, alphaTools,
    "If we add 2 more gateway replicas at $0.15/hour each, what's the monthly cost increase?",
  );

  // --- Team Beta scenarios ---

  console.log("\n" + "=".repeat(60));
  console.log("  TEAM BETA (Backend) — API & Architecture");
  console.log("=".repeat(60));

  await askAgent(
    "team-beta", betaRuntime, beta.memory, betaTools,
    "Our payments endpoint is slow and the webhooks are failing. What's the current health?",
  );

  await askAgent(
    "team-beta", betaRuntime, beta.memory, betaTools,
    "What's our error budget if our SLA is 99.9% uptime and we have 10 million requests per month?",
  );

  // ── 9. Verify isolation ──

  console.log("=".repeat(60));
  console.log("  ISOLATION VERIFICATION");
  console.log("=".repeat(60));

  const alphaSeesKubernetes = await alpha.memory.search("Kubernetes");
  const betaSeesKubernetes = await beta.memory.search("Kubernetes");
  console.log(`\n  Alpha searches "Kubernetes": ${alphaSeesKubernetes.length} results (should be >0)`);
  console.log(`  Beta searches "Kubernetes":  ${betaSeesKubernetes.length} results (should be 0)`);

  const alphaSeesStripe = await alpha.memory.search("Stripe payments");
  const betaSeesStripe = await beta.memory.search("Stripe payments");
  console.log(`  Alpha searches "Stripe":     ${alphaSeesStripe.length} results (should be 0)`);
  console.log(`  Beta searches "Stripe":      ${betaSeesStripe.length} results (should be >0)`);

  const alphaCreds = await alpha.credentials.list();
  const betaCreds = await beta.credentials.list();
  console.log(`\n  Alpha credentials: [${alphaCreds}]  (Beta can't see these)`);
  console.log(`  Beta credentials:  [${betaCreds}]  (Alpha can't see these)`);

  const betaSeesPagerduty = await beta.credentials.resolve("pagerduty");
  console.log(`  Beta resolves Alpha's "pagerduty": ${betaSeesPagerduty === undefined ? "undefined (correct)" : "LEAKED!"}`);

  // ── 10. Cleanup ──

  await alpha.destroy();
  await beta.destroy();
  fs.rmSync(STATE_DIR, { recursive: true, force: true });

  console.log("\nDemo complete.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
