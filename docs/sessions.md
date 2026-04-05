# Session Continuity

Sessions allow agents to maintain conversation context across multiple interactions. Each session is identified by a string ID and stores the full message history.

## Basic Usage

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

## How It Works

Sessions are per-workspace, stored as JSONL transcripts with async locking. Each session tracks:

- Full message history (user + assistant + tool calls)
- Model used
- Creation and update timestamps

## Named vs Auto-generated Sessions

```typescript
// Named session — persistent, resumable
await runtime.run({ message: "...", sessionId: "user-alice" });

// Auto-generated — ephemeral
const result = await runtime.run({ message: "..." });
// result.sessionId → "session_1712345678901"
```

## Session Pruning

For long conversations, older tool results can be pruned to stay within context limits:

```typescript
import { pruneContextMessages } from "cloison-runtime";

const pruned = pruneContextMessages(messages, {
  maxTokens: 100_000,
  preserveSystemMessages: true,
});
```

## State Directory

```
<stateDir>/workspaces/<userId>/
├── sessions.json           # Session index
└── sessions/
    └── <sessionId>/        # JSONL transcripts
```

## Source Files

- `src/sessions/store.ts` — File-based store with async locking
- `src/sessions/transcript-events.ts` — Transcript event handling
- `src/runtime/session-pruning.ts` — Context pruning
