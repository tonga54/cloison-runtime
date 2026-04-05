# Per-Workspace Skills

Skills are registered globally and **enabled per workspace**. Each workspace gets exactly the capabilities it needs — nothing more.

## Setup

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

## Writing a Skill

A skill is a directory with `SKILL.md` (LLM-readable description) and `execute.js` (the executable):

```
skills/
└── github-issues/
    ├── SKILL.md          # Description for the LLM
    └── execute.js        # Runs with injected credentials
```

### SKILL.md

```markdown
# GitHub Issues

Create, list, and manage GitHub issues. Use when the user asks about issues, bugs, or feature requests.
```

### execute.js

```javascript
const params = JSON.parse(await readStdin());
const token = process.env.token;  // Injected from credentials
const res = await fetch(`https://api.github.com/repos/${params.repo}/issues`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log(JSON.stringify(await res.json()));
```

## Execution Environment

Skills run with a minimal environment:

- `PATH`, `HOME`, `NODE_ENV` (system)
- Credential keys injected as env vars
- 30s timeout
- 10 MB stdout/stderr cap
- Dangerous env keys blocked (`NODE_OPTIONS`, `LD_PRELOAD`, `BASH_ENV`, etc.)

## Registering Skills

```typescript
const platform = createPlatform({ stateDir: "/var/bulkhead-runtime" });

// Register from a directory
platform.skills.register("/path/to/github-issues");

// List registered skills
platform.skills.list();
// → [{ id: "github-issues", name: "GitHub Issues", description: "..." }]
```

## Source Files

- `src/skills/registry.ts` — Global skill catalog
- `src/skills/enablement.ts` — Per-workspace enablement
- `src/skills/loader.ts` — Skill loading from directories
