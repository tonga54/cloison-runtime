<p align="center">
  <br />
  <img src="docs/assets/hero-banner.png" alt="Bulkhead Runtime" width="100%" />
  <br /><br />
  <a href="https://www.npmjs.com/package/bulkhead-runtime"><img src="https://img.shields.io/npm/v/bulkhead-runtime?style=flat-square&color=00ff41&labelColor=0d1117" alt="npm" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square&labelColor=0d1117" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-brightgreen?style=flat-square&labelColor=0d1117&logo=node.js&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/runtime_deps-3-00ff41?style=flat-square&labelColor=0d1117" alt="deps" />
  <img src="https://img.shields.io/badge/tests-279_passing-00ff41?style=flat-square&labelColor=0d1117" alt="tests" />
  <img src="https://img.shields.io/badge/sandbox-5_isolation_layers-ff6b6b?style=flat-square&labelColor=0d1117" alt="isolation" />
  <img src="https://img.shields.io/badge/crypto-AES--256--GCM-blueviolet?style=flat-square&labelColor=0d1117" alt="crypto" />
  <img src="https://img.shields.io/badge/cold_start-~50ms-00ff41?style=flat-square&labelColor=0d1117" alt="cold start" />
</p>

<br />

<p align="center">
  <b>Run 1,000 AI agents on a single Linux box.</b><br />
  Each in its own OS namespace. Each with private memory, encrypted credentials, and an isolated filesystem.<br />
  <b>No Docker. No cloud. No VMs. One <code>npm install</code>.</b>
</p>

<p align="center">
  <i>Built on production-hardened internals from <a href="https://github.com/nicepkg/openclaw">OpenClaw</a> — failover, SSRF protection, embedding pipelines, session indexing, and more.</i>
</p>

<br />

---

<p align="center">
  <img src="docs/assets/features.png" alt="Key Features" width="100%" />
</p>

---

## Why This Exists

Every AI platform hits the same wall: **you need multiple agents running on the same server, and they absolutely cannot see each other's data.**

Customer A's API keys must never leak to Customer B. Team Engineering's database credentials can't bleed into Team Marketing's agent. A rogue agent shouldn't be able to read `/etc/shadow` or exfiltrate data through DNS.

The usual answers — Docker per user, cloud VMs, or "just be careful with access control" — are either too heavy, too expensive, or too fragile.

**Bulkhead Runtime solves this at the kernel level.** Each agent runs inside Linux namespaces with 5 layers of OS isolation, encrypted credential stores, private memory databases, and SSRF-hardened HTTP. It's a library — `npm install` it, call `createPlatform()`, and you have production-grade multi-tenant isolation in your app.

---

## Quick Start

```bash
npm install bulkhead-runtime
```

```typescript
import { createPlatform } from "bulkhead-runtime";

const platform = createPlatform({
  stateDir: "/var/bulkhead-runtime",
  credentialPassphrase: process.env.CREDENTIAL_KEY,
});

const workspace = await platform.createWorkspace("user-42", {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
});

const result = await workspace.run({
  message: "Refactor the auth module to use JWT",
  sessionId: "project-alpha",
});
```

> **Requires:** Linux + Node.js 22.12+
>
> **macOS / Windows dev:**
> ```bash
> git clone https://github.com/tonga54/bulkhead-runtime.git && cd bulkhead-runtime
> docker compose run dev bash
> pnpm test  # 279 tests, all green
> ```

---

## Use Cases

<table>
<tr>
<td width="50%">

**One agent per customer in your SaaS**

Your platform gives each customer an AI agent. Each agent accesses that customer's repos, APIs, and databases — with their own credentials. Customer A's agent can never see Customer B's tokens, data, or conversation history.

```typescript
app.post("/api/agent", async (req, res) => {
  const ws = await platform.getWorkspace(req.org.id);
  const result = await ws.run({
    message: req.body.message,
    sessionId: req.body.threadId,
  });
  res.json({ response: result.response });
});
```

</td>
<td width="50%">

**Per-team agents inside your company**

Engineering, ops, and data each get their own agent. Each team's agent connects to their own tools — different GitHub orgs, different databases, different cloud accounts. No credential leaks between teams.

```typescript
const eng  = await platform.createWorkspace("engineering");
const ops  = await platform.createWorkspace("ops");
const data = await platform.createWorkspace("data-team");

eng.skills.enable("github-pr");
ops.skills.enable("pagerduty");
data.skills.enable("bigquery");

await eng.credentials.store("github", { token: "ghp_eng..." });
await ops.credentials.store("pagerduty", { token: "pd_..." });
await data.credentials.store("gcp", { key: "..." });
```

</td>
</tr>
<tr>
<td width="50%">

**Client-isolated agents in consulting / agencies**

Each client project gets its own workspace. The agent knows that client's stack, their conventions, their infra. When you offboard a client, `deleteWorkspace()` wipes everything — memory, credentials, sessions.

```typescript
const acme = await platform.createWorkspace("client-acme");
await acme.credentials.store("aws", { key: "...", secret: "..." });
await acme.credentials.store("jira", { token: "..." });

await acme.run({
  message: "Check the staging deploy and open a Jira ticket if it failed",
  sessionId: "daily-ops",
});

await platform.deleteWorkspace("client-acme");
```

</td>
<td width="50%">

**Ephemeral agents for CI / PR review / task runners**

Spin up a workspace per job, per PR, or per deploy. The agent runs, does its thing, and the workspace is destroyed. No state leaks between runs.

```typescript
const jobId = `deploy-${Date.now()}`;
const ws = await platform.createWorkspace(jobId);

await ws.credentials.store("k8s", { kubeconfig: "..." });
ws.skills.enable("kubectl");

const result = await ws.run({
  message: "Roll out v2.3.1 to staging, run smoke tests, report status",
});

await platform.deleteWorkspace(jobId);
```

</td>
</tr>
</table>

**The common thread:** you have multiple tenants (users, teams, clients, jobs) and each one needs an AI agent with its own secrets, tools, and memory — on the same server, without any cross-contamination.

---

## How It Works

<p align="center">
  <img src="docs/assets/architecture.png" alt="Architecture" width="100%" />
</p>

```mermaid
graph TB
  subgraph HOST["HOST PROCESS"]
    subgraph WA["Workspace A"]
      WA_mem["memory.db"]
      WA_cred["creds.enc"]
      WA_sess["sessions/"]
      WA_skill["skills[]"]
    end
    subgraph WB["Workspace B"]
      WB_mem["memory.db"]
      WB_cred["creds.enc"]
      WB_sess["sessions/"]
      WB_skill["skills[]"]
    end
    subgraph WN["Workspace N"]
      WN_mem["memory.db"]
      WN_cred["creds.enc"]
      WN_sess["sessions/"]
      WN_skill["skills[]"]
    end

    subgraph SA["Sandbox A — user ns · mount ns · pid ns · net ns · cgroup v2"]
      AgentA["Agent A"]
    end
    subgraph SB["Sandbox B — user ns · mount ns · pid ns · net ns · cgroup v2"]
      AgentB["Agent B"]
    end
    subgraph SN["Sandbox N — user ns · mount ns · pid ns · net ns · cgroup v2"]
      AgentN["Agent N"]
    end
  end

  WA -->|"JSON-RPC IPC"| SA
  WB -->|"JSON-RPC IPC"| SB
  WN -->|"JSON-RPC IPC"| SN
```

> Agent A cannot see Agent B's files, memory, credentials, or processes. Not by policy. **By kernel enforcement.**

---

## Why Bulkhead Over Alternatives

| | Docker per user | E2B / Cloud | **Bulkhead Runtime** |
|:---|:---:|:---:|:---:|
| **Isolation mechanism** | Container per user | Cloud VM per session | **Linux namespaces** |
| **Credential security** | DIY | Not built-in | **AES-256-GCM, never exposed to agent** |
| **Persistent memory** | DIY | DIY | **SQLite + vector embeddings per tenant** |
| **Embedding cache + batch** | DIY | DIY | **SQLite cache, batch with retry** |
| **SSRF protection** | DIY | DIY | **DNS-resolve-and-pin, private-IP blocking, fail-closed** |
| **Model fallback** | DIY | DIY | **Automatic multi-model fallback chains** |
| **API key rotation** | DIY | DIY | **Multi-key with rate-limit rotation** |
| **Parallel subagents** | DIY | DIY | **Built-in with depth limiting** |
| **Skills with secret injection** | DIY | DIY | **Credentials injected server-side** |
| **Infrastructure** | Docker daemon | Cloud API + billing | **Single npm package** |
| **Cold start** | ~2s | ~5-10s | **~50ms** |
| **Embeddable in your app** | No | No | **Yes — it's a library** |
| **License** | — | Proprietary | **MIT** |

---

## Single-User Mode

The fastest path for prototyping or single-agent use. No platform needed.

```typescript
import { createRuntime } from "bulkhead-runtime";

const runtime = await createRuntime({
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
});

const result = await runtime.run({
  message: "Find all TODO comments and create a summary",
});
```

The agent runs inside a Linux namespace sandbox with full coding tools (read, write, edit, bash, grep, find, ls) and autonomous memory (`memory_store`, `memory_search`).

---

## Multi-Tenant Isolation

This is the core of Bulkhead Runtime. Each user gets a **workspace** — a fully isolated environment with its own memory, encrypted credentials, enabled skills, and session history. Workspaces are physically separated at the OS level.

```typescript
import { createPlatform } from "bulkhead-runtime";

const platform = createPlatform({
  stateDir: "/var/bulkhead-runtime",
  credentialPassphrase: process.env.CREDENTIAL_KEY,
});

const alice = await platform.createWorkspace("alice", {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
});

const bob = await platform.createWorkspace("bob", {
  provider: "google",
  model: "gemini-2.5-flash",
});
```

### What "isolated" actually means

When `workspace.run()` executes, Bulkhead spawns a **child process** with 5 layers of kernel isolation. The agent **never runs in your application's process**.

```mermaid
sequenceDiagram
    participant App as Your App
    participant Host as Host Process
    participant Sandbox as Sandbox (isolated)

    App->>Host: workspace.run({ message })
    Host->>Host: Load session history
    Host->>Host: Resolve enabled skills
    Host->>Host: Detect sandbox capabilities
    Host->>Sandbox: Spawn child process (unshare)
    activate Sandbox
    Note over Sandbox: Enter user namespace<br/>pivot_root → new filesystem<br/>PID namespace (own procs)<br/>Network ns (loopback only)<br/>cgroup v2 (mem/cpu/pid cap)
    Sandbox->>Host: IPC: memory.search
    Host-->>Sandbox: search results
    Sandbox->>Host: IPC: memory.store
    Host-->>Sandbox: store confirmation
    Sandbox->>Host: IPC: skill.execute
    Host->>Host: Decrypt credentials (AES-256-GCM)
    Host-->>Sandbox: skill output (no credentials)
    Sandbox-->>Host: Agent response
    deactivate Sandbox
    Host->>Host: Kill child process
    Host->>Host: Fire lifecycle hooks
    Host->>Host: Update session store
    Host-->>App: { response, session }
```

The agent gets coding tools (bash, file read/write/edit) because the mount namespace restricts its entire filesystem view. **It literally cannot see anything outside its sandbox.**

---

## Credential Security

Credentials are **AES-256-GCM encrypted** at rest. PBKDF2 key derivation with 100k iterations (SHA-512). The agent **never** sees raw secrets — not through tools, not through IPC, not through environment variables.

```typescript
await alice.credentials.store("github", { token: "ghp_alice_secret" });
await alice.credentials.store("openai", { apiKey: "sk-..." });
```

```mermaid
sequenceDiagram
    participant Agent as Agent (sandboxed)
    participant Host as Host Process
    participant Skill as Skill Script

    Agent->>Host: skill_execute({ skillId: "github-issues" })
    Host->>Host: Resolve skill directory
    Host->>Host: Decrypt credentials (AES-256-GCM)
    Host->>Skill: Spawn script with credentials as env vars
    activate Skill
    Skill->>Skill: process.env.token → use API
    Skill-->>Host: stdout → JSON result
    deactivate Skill
    Host-->>Agent: Result string (no credentials)
    Note over Agent: ✗ Never sees the token<br/>✗ Cannot read credential file<br/>✗ Cannot intercept env vars
```

System environment variables (`PATH`, `HOME`, `NODE_ENV`) are protected from credential key collision. Skill IDs are validated against prototype pollution.

---

## Per-Workspace Skills

Skills are registered globally and **enabled per workspace**. Each workspace gets exactly the capabilities it needs — nothing more.

```typescript
const frontend = await platform.createWorkspace("team-frontend");
const backend  = await platform.createWorkspace("team-backend");

frontend.skills.enable("github-issues");
backend.skills.enable("github-issues");
backend.skills.enable("db-migration");

await frontend.credentials.store("github", { token: "ghp_frontend_token" });
await backend.credentials.store("github", { token: "ghp_backend_token" });
await backend.credentials.store("database", { url: "postgres://prod:5432/app" });
```

```javascript
// skills/github-issues/execute.js
const params = JSON.parse(await readStdin());
const token = process.env.token;
const res = await fetch(`https://api.github.com/repos/${params.repo}/issues`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log(JSON.stringify(await res.json()));
```

Skills run with a minimal env (`PATH`, `HOME`, `NODE_ENV` + credentials), 30s timeout, and 10 MB stdout/stderr cap.

---

## Memory Isolation

Each workspace has its own SQLite database. Memories never cross workspace boundaries — not by access control, **by physical separation**.

```typescript
await alice.memory.store("Project uses React and TypeScript");
await bob.memory.store("Project uses Vue and Python");

const search = await alice.memory.search("framework");
// → "React and TypeScript"
// Bob's data doesn't exist in Alice's universe.
```

### Autonomous Agent Memory

The agent decides what to remember. Memory persists across sessions, across restarts.

```typescript
// Session 1
await runtime.run({
  message: "My name is Juan, I work in fintech, I prefer TypeScript",
  sessionId: "onboarding",
});

// Session 2 — different session, memory persists
await runtime.run({
  message: "Set up a new project for me",
  sessionId: "new-project",
});
// Agent searches memory → finds preferences → scaffolds TypeScript project
```

**Hybrid search engine under the hood:**

| Stage | Algorithm |
|:---|:---|
| **Vector search** | Cosine similarity against stored embeddings |
| **Keyword search** | SQLite FTS5 with BM25 ranking |
| **Fusion** | Weighted merge of vector + keyword scores |
| **Temporal decay** | Exponential time-based score attenuation |
| **Diversity** | MMR (Maximal Marginal Relevance) re-ranking |
| **Query expansion** | 7-language keyword extraction (EN/ES/PT/ZH/JA/KO/AR) |

Works without any embedding API key — falls back to FTS5 keyword search.

---

## Session Continuity

```typescript
await workspace.run({
  message: "Create a REST API for user management",
  sessionId: "api-project",
});

// Later — agent sees the full conversation history
await workspace.run({
  message: "Add input validation to those endpoints",
  sessionId: "api-project",
});
```

Sessions are per-workspace, stored as JSONL transcripts with async locking.

---

## Subagent Orchestration

Agents can spawn sub-agents for parallel or complex work. Sub-agents run concurrently with controlled parallelism and depth limiting.

```typescript
const result = await runtime.run({
  message: "Review this PR for security and performance",
  enableSubagents: true,
});
```

Or programmatically:

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

---

## Lifecycle Hooks

```typescript
workspace.hooks.register("before_tool_call", async ({ toolName, input }) => {
  await auditLog.write({ tool: toolName, input, timestamp: Date.now() });
});

workspace.hooks.register("after_agent_end", async ({ sessionId, result }) => {
  await billing.recordUsage(workspace.id, sessionId);
});
```

6 hook points: `session_start` · `session_end` · `before_agent_start` · `after_agent_end` · `before_tool_call` · `after_tool_call`

---

## Model Fallback & API Key Rotation

When a model fails, Bulkhead automatically falls back to the next candidate. The error classification engine — ported from [OpenClaw](https://github.com/nicepkg/openclaw)'s battle-tested failover system — covers rate limits, billing, auth, overload, timeout, model not found, context overflow, and provider-specific patterns (Bedrock, Groq, Azure, Ollama, Mistral, etc.). Providers in cooldown are skipped automatically. When a key is rate-limited, it rotates to the next one.

```typescript
const result = await runtime.run({
  message: "Analyze this codebase",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",

  fallbacks: ["openai/gpt-4o", "google/gemini-2.5-flash"],

  apiKeys: [process.env.ANTHROPIC_KEY_1!, process.env.ANTHROPIC_KEY_2!],
});
```

Or set keys via environment variables:

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_API_KEYS=sk-ant-key1,sk-ant-key2,sk-ant-key3
ANTHROPIC_API_KEY_1=sk-ant-...
ANTHROPIC_API_KEY_2=sk-ant-...
```

---

## Context Window Guards

Prevents silent failures from models with insufficient context windows.

```typescript
import { resolveContextWindowInfo, evaluateContextWindowGuard } from "bulkhead-runtime";

const info = resolveContextWindowInfo({
  modelContextWindow: model.contextWindow,
  configContextTokens: 16_000,
});

const guard = evaluateContextWindowGuard({ info });
// guard.shouldWarn  → true if below 32,000 tokens
// guard.shouldBlock → true if below 16,000 tokens
```

The runtime applies these guards automatically before every agent execution.

---

## Retry with Compaction

Transient errors (rate limits, timeouts, context overflow) trigger automatic retry with exponential backoff.

```typescript
const result = await runtime.run({
  message: "Refactor the auth module",
  maxRetries: 3,
});
// On context overflow → SDK compaction reduces history
// On 429/5xx → exponential backoff + jitter
```

---

## Embedding Pipeline

### Embedding Cache

Embeddings are cached in SQLite to avoid re-embedding unchanged content. Enabled by default.

```typescript
const memory = createSimpleMemoryManager({
  dbDir: "/var/data/memory",
  embeddingProvider: createEmbeddingProvider({ provider: "openai", apiKey: "..." }),
  enableEmbeddingCache: true,
  maxCacheEntries: 50_000,
});
```

### Batch Embedding with Retry

```typescript
import { embedBatchWithRetry } from "bulkhead-runtime";

const result = await embedBatchWithRetry(
  ["text 1", "text 2", "text 3"],
  {
    provider: embeddingProvider,
    cache: memory.embeddingCache ?? undefined,
    batchSize: 100,
    concurrency: 2,
    retryAttempts: 3,
  },
);
// result: { embeddings: [...], cached: 150, computed: 50, errors: 0 }
```

### SSRF Protection

All embedding provider HTTP calls are protected against Server-Side Request Forgery by default. The SSRF engine — ported from [OpenClaw](https://github.com/nicepkg/openclaw) — resolves DNS and pins IPs before connecting, blocks private/link-local ranges, and enforces a hostname allowlist. Fail-closed by default.

```typescript
import { validateUrl, buildBaseUrlPolicy } from "bulkhead-runtime";

const provider = createEmbeddingProvider({
  provider: "openai",
  apiKey: "...",
  enableSsrf: true,
});

await validateUrl("https://api.openai.com/v1/embeddings"); // OK
await validateUrl("http://169.254.1.1/steal");              // throws SSRF error
```

---

## File-based Memory Indexing

Automatically watches `MEMORY.md` and `memory/` directory for changes and re-indexes them into the memory system.

```typescript
import { createFileIndexer } from "bulkhead-runtime";

const indexer = createFileIndexer({
  workspaceDir: "/path/to/workspace",
  memory,
  watchPaths: ["docs/"],
  debounceMs: 2000,
});

indexer.start();
indexer.stop();
```

---

## Session Transcript Indexing

Indexes session transcripts into memory for cross-session search. Supports post-compaction re-indexing. Ported from [OpenClaw](https://github.com/nicepkg/openclaw)'s memory-core extension.

```typescript
import { createSessionIndexer } from "bulkhead-runtime";

const indexer = createSessionIndexer({
  sessionsDir: path.join(stateDir, "sessions"),
  memory,
  deltaBytes: 4096,
  deltaMessages: 10,
});

await indexer.indexAllSessions();
indexer.onTranscriptUpdate(sessionFile);
```

---

## Structured Logging

Structured JSON logging with file output, rotation, and configurable levels.

```typescript
import { configureLogger, createSubsystemLogger } from "bulkhead-runtime";

configureLogger({
  level: "debug",
  file: "/var/log/bulkhead-runtime.log",
  maxFileBytes: 10 * 1024 * 1024,
  json: true,
});

const log = createSubsystemLogger("my-module");
log.info("agent started", { userId: "alice", model: "claude-sonnet-4-20250514" });
```

Or via environment:

```bash
BULKHEAD_LOG_LEVEL=debug
BULKHEAD_LOG_FILE=/var/log/bulkhead-runtime.log
```

---

## Security Architecture

<p align="center">
  <img src="docs/assets/security-layers.png" alt="5 Layers of Sandbox Isolation" width="100%" />
</p>

### 5 Layers of Sandbox Isolation

All layers are **fail-closed** — if any layer can't be applied, the sandbox refuses to start.

```mermaid
block-beta
  columns 1
  block:L1["Layer 1 — User Namespace · unprivileged creation via unshare(2)"]
    columns 1
    block:L2["Layer 2 — Mount Namespace · pivot_root → new root · old root unmounted"]
      columns 1
      block:L3["Layer 3 — PID Namespace · agent only sees its own processes"]
        columns 1
        block:L4["Layer 4 — Network Namespace · loopback only · no external access"]
          columns 1
          L5["Layer 5 — cgroups v2 · memory.max · pids.max · cpu.weight"]
        end
      end
    end
  end
  AGENT["Agent process — can only see its own isolated world"]

  L1 --> AGENT
```

### Defense in Depth

| Defense | Mechanism |
|:---|:---|
| **Env allowlist** | Only `PATH`, `HOME`, `NODE_ENV` + the single API key the agent needs. Everything else dropped. |
| **Credential proxy** | Secrets decrypted server-side, injected into skill execution. Never sent over IPC. |
| **Path traversal blocklist** | `/proc`, `/sys`, `/home/`, `/etc/shadow`, `/run/docker.sock`, and more are blocked from bind mounts. |
| **Symlink rejection** | `additionalBinds` sources must not be symlinks (prevents TOCTOU attacks). |
| **IPC rate limiting** | 200 calls/sec per method. Prevents resource exhaustion from rogue agents. |
| **IPC buffer limit** | 50 MB max. Peer stops on overflow to prevent memory exhaustion. |
| **Prototype pollution guard** | `__proto__`, `constructor`, `prototype` rejected as skill/credential IDs. |
| **Stdout interception** | IPC uses a dedicated fd. All other stdout is redirected to stderr. |
| **Sensitive path validation** | `workspaceDir`, `projectDir`, `nodeExecutable`, `additionalBinds` all validated. |
| **Atomic writes** | Config, credentials, sessions, skill state — all use tmp+rename pattern. |

---

## Provider Support

### LLM Providers

Any provider supported by [pi-ai](https://github.com/nicepkg/pi-ai):

| Provider | Example Model |
|:---|:---|
| **Anthropic** | `claude-sonnet-4-20250514` |
| **Google** | `gemini-2.5-flash` |
| **OpenAI** | `gpt-4o` |
| **Groq** | `llama-3.3-70b-versatile` |
| **Cerebras** | `llama-3.3-70b` |
| **Mistral** | `mistral-large-latest` |
| **xAI** | `grok-3` |

### Embedding Providers

Optional — keyword search works without any API key.

| Provider | Default Model | Local |
|:---|:---|:---:|
| **OpenAI** | `text-embedding-3-small` | |
| **Gemini** | `gemini-embedding-001` | |
| **Voyage** | `voyage-3-lite` | |
| **Mistral** | `mistral-embed` | |
| **Ollama** | `nomic-embed-text` | **Yes** |

---

## Architecture

```
src/
├── platform/          createPlatform() — workspace CRUD, skill registry
├── workspace/         createWorkspace() — scoped memory, sessions, runner
│   └── runner.ts      Out-of-process agent execution via sandbox + IPC
├── sandbox/           Linux namespace sandbox — zero external deps
│   ├── namespace.ts       unshare(2) + pivot_root
│   ├── cgroup.ts          cgroups v2 resource limits (fail-closed)
│   ├── rootfs.ts          Minimal rootfs with bind mounts
│   ├── ipc.ts             Bidirectional JSON-RPC 2.0 over stdio
│   ├── seccomp.ts         BPF syscall filter profiles
│   ├── seccomp-apply.ts   seccomp-BPF application via C helper
│   ├── proxy-tools.ts     memory/skill tools proxied to host via IPC
│   └── worker.ts          Agent entry point inside sandbox
├── credentials/       AES-256-GCM encrypted store + credential proxy
├── skills/            Global registry + per-workspace enablement
├── runtime/           createRuntime() — single-user mode
│   ├── model-fallback.ts   Automatic model fallback chains
│   ├── context-guard.ts    Context window validation + guards
│   ├── retry.ts            Exponential backoff with jitter
│   ├── api-key-rotation.ts Multiple keys with rate-limit rotation
│   ├── subagent.ts         Parallel subagent execution + registry
│   └── stream-adapters.ts  Per-provider stream configuration
├── memory/            Hybrid search engine
│   ├── hybrid.ts          Vector + FTS5 fusion scoring
│   ├── mmr.ts             Maximal Marginal Relevance re-ranking
│   ├── temporal-decay.ts  Exponential time-based scoring
│   ├── query-expansion.ts 7-language keyword expansion
│   ├── embedding-cache.ts SQLite embedding cache
│   ├── embedding-batch.ts Batch embedding with retry
│   ├── file-indexer.ts    File-based memory indexing with fs.watch
│   ├── session-indexer.ts Session transcript indexing
│   └── ssrf.ts            SSRF protection for HTTP calls
├── hooks/             6 lifecycle hook points
├── logging/           Structured JSON logging with file output
├── sessions/          File-based store with async locking
└── config/            Configuration loading
```

**75 source files** · **3 runtime deps** · Sandbox, crypto, IPC, logging, and SSRF use **zero external deps** — all Node.js built-ins.

---

## State Directory

```
<stateDir>/
├── skills/                          # Global skill catalog
│   └── <skill-id>/
│       ├── SKILL.md                 # LLM-readable skill description
│       └── execute.js               # Runs with injected credentials
└── workspaces/
    └── <userId>/
        ├── config.json              # Workspace config (no secrets)
        ├── credentials.enc.json     # AES-256-GCM encrypted credentials
        ├── enabled-skills.json      # Which skills this workspace can use
        ├── sessions.json            # Session index
        ├── sessions/                # JSONL transcripts
        └── memory/
            └── memory.db            # SQLite (vectors + FTS5)
```

Every file is workspace-scoped. No shared state between tenants.

---

## Built on OpenClaw

Bulkhead Runtime stands on the shoulders of [OpenClaw](https://github.com/nicepkg/openclaw). Several production-critical subsystems were ported directly from OpenClaw's codebase:

| Subsystem | Origin |
|:---|:---|
| **Model fallback & error classification** | `src/agents/model-fallback.ts`, `failover-error.ts`, `failover-policy.ts` |
| **API key rotation** | `src/agents/api-key-rotation.ts`, `live-auth-keys.ts` |
| **Context window guards** | `src/agents/context-window-guard.ts` |
| **Retry with backoff** | `src/infra/retry.ts` |
| **SSRF protection** | `src/infra/net/ssrf.ts`, `fetch-guard.ts` |
| **Embedding cache & batch** | `extensions/memory-core/src/memory/manager-embedding-ops.ts` |
| **File indexer** | `extensions/memory-core/src/memory/manager-sync-ops.ts` |
| **Session transcript indexer** | `extensions/memory-core/src/memory/manager-sync-ops.ts` |
| **Subagent orchestration** | `src/agents/subagent-*.ts` |
| **Structured logging** | `src/logging/logger.ts`, `subsystem.ts`, `levels.ts` |
| **Transcript events** | `src/sessions/transcript-events.ts` |

OpenClaw solved these problems in production. We extracted, adapted, and integrated them into Bulkhead's multi-tenant architecture. Full credit where it's due.

---

## Requirements

- **Linux** — bare metal, VM, or container with `--privileged`
- **Node.js 22.12+** — uses `node:sqlite` built-in
- **macOS / Windows** — `docker compose run dev` for development

## License

[MIT](LICENSE)
