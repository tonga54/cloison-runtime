# Demos

All demos run inside the Docker development container:

```bash
git clone https://github.com/tonga54/bulkhead-runtime.git && cd bulkhead-runtime
docker compose run dev bash
```

## Demos requiring API key

Set `GEMINI_API_KEY` (or your provider's key) before running.

| Demo | Command | Description |
|------|---------|-------------|
| **Workspace Real** | `npx tsx demos/demo-workspace-real.ts` | Full multi-tenant scenario: 2 teams with skills, memory, credentials, agent execution, and isolation verification. Also requires `BULKHEAD_CREDENTIAL_KEY`. |
| **Subagents** | `npx tsx demos/demo-subagents.ts` | Orchestrator delegates to specialist sub-agents (historian, chemist, biologist, mathematician). |
| **Sessions** | `npx tsx demos/demo-sessions.ts` | Named sessions, auto-generated IDs, specialized agents, lifecycle hooks. |
| **Memory** | `npx tsx demos/demo-memory.ts` | Gemini embeddings, semantic search, FTS5 keyword search, hybrid ranking. |

## Demos running locally (no API key)

| Demo | Command | Description |
|------|---------|-------------|
| **Parallel Subagents** | `npx tsx demos/demo-parallel-subagents.ts` | Concurrency control, timeouts, depth limiting, registry — all with mocked runners. |
| **Error Classification** | `npx tsx demos/demo-error-classification.ts` | Classifies HTTP status codes and error messages into failover signals. |
| **Fallback** | `npx tsx demos/demo-fallback.ts` | Model fallback chains, cooldown tracking, API key rotation — with simulated failures. |
| **SSRF** | `npx tsx demos/demo-ssrf.ts` | Private IP detection, hostname blocking, URL validation, allowlists. |
| **Logging** | `npx tsx demos/demo-logging.ts` | Compact, pretty, and JSON styles. File output, child loggers, level filtering. |
| **File Indexer** | `npx tsx demos/demo-file-indexer.ts` | Indexes MEMORY.md + memory/ files into FTS5. Re-sync, modify, delete. |
| **Platform** | `npx tsx demos/demo-platform.ts` | Multi-tenant CRUD, memory isolation, credential encryption, path traversal protection. Requires `BULKHEAD_CREDENTIAL_KEY`. |
| **Sandbox Capabilities** | `npx tsx demos/demo-sandbox-capabilities.ts` | Credential encryption, proxy injection, sandbox readiness check. |

## Example Skills

The `demos/skills/` directory contains three example skills used by `demo-workspace-real.ts`:

- `deploy-status/` — Returns deployment status of services (healthy, degraded, replicas)
- `api-health/` — Returns endpoint health (latency, error rates, circuit breaker status)
- `calculator/` — Evaluates math expressions safely
