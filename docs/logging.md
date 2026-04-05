# Structured Logging

Cloison Runtime includes a structured logging system with subsystem tagging, multiple output styles, and file rotation.

## Configuration

```typescript
import { configureLogger, createSubsystemLogger } from "cloison-runtime";

configureLogger({
  level: "debug",
  file: "/var/log/cloison-runtime.log",
  maxFileBytes: 10 * 1024 * 1024,
  json: true,
});

const log = createSubsystemLogger("my-module");
log.info("agent started", { userId: "alice", model: "claude-sonnet-4-20250514" });
```

Or via environment:

```bash
CLOISON_LOG_LEVEL=debug
CLOISON_LOG_FILE=/var/log/cloison-runtime.log
```

## Output Styles

### Compact (default)

```
[my-module] agent started
```

### Pretty (with timestamps)

```
2026-04-05T10:30:00.000Z [INFO ] [my-module] agent started {"userId":"alice"}
```

### JSON

```json
{"time":"2026-04-05T10:30:00.000Z","level":"info","subsystem":"my-module","message":"agent started","userId":"alice"}
```

## Log Levels


| Level    | Priority | Use                  |
| -------- | -------- | -------------------- |
| `fatal`  | 0        | Unrecoverable errors |
| `error`  | 1        | Operation failures   |
| `warn`   | 2        | Degraded behavior    |
| `info`   | 3        | Normal operations    |
| `debug`  | 4        | Development detail   |
| `trace`  | 5        | Fine-grained tracing |
| `silent` | Infinity | Suppress all output  |


## Child Loggers

```typescript
const memoryLog = createSubsystemLogger("memory");
const searchLog = createSubsystemLogger("memory/search");
const embedLog = createSubsystemLogger("memory/embeddings");
```

## Separate Console and File Levels

```typescript
configureLogger({
  level: "debug",           // File level
  consoleLevel: "error",    // Console level
  file: "/var/log/app.log",
});
```

## Source Files

- `src/logging/subsystem.ts` — Logger implementation, file output, rotation

