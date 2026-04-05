/**
 * Demo: Structured logging system
 *
 * Shows:
 * - Log levels (trace, debug, info, warn, error, fatal, silent)
 * - JSON file output with rolling log files by date
 * - Console styles: pretty, compact, json
 * - Separate file and console log levels
 * - Child loggers with prefixed subsystem names
 * - consoleMessage override (different message for console vs file)
 * - Subsystem prefix stripping for cleaner console output
 *
 * Run: npx tsx demos/demo-logging.ts
 * Note: No API key needed — runs entirely locally.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  configureLogger,
  createSubsystemLogger,
  levelToMinLevel,
  normalizeLogLevel,
  stripRedundantSubsystemPrefixForConsole,
} from "../src/logging/subsystem.js";

const LOG_DIR = ".demo-logs";

function main() {
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  console.log("=== Structured Logging Demo ===\n");

  // --- Level system ---
  console.log("--- Log level priorities ---\n");
  const levels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
  for (const level of levels) {
    console.log(`  ${level.padEnd(8)} → priority ${levelToMinLevel(level)}`);
  }

  console.log(`\n  normalizeLogLevel("unknown") → "${normalizeLogLevel("unknown")}"`);
  console.log(`  normalizeLogLevel("debug")   → "${normalizeLogLevel("debug")}"`);

  // --- Compact console style ---
  console.log("\n--- Console style: compact (default) ---\n");
  configureLogger({ level: "debug", consoleLevel: "debug", consoleStyle: "compact" });
  const log1 = createSubsystemLogger("demo/compact");
  log1.info("this is an info message");
  log1.warn("this is a warning");
  log1.error("this is an error");
  log1.debug("this is debug output");

  // --- Pretty console style ---
  console.log("\n--- Console style: pretty (with timestamps) ---\n");
  configureLogger({ level: "debug", consoleLevel: "debug", consoleStyle: "pretty" });
  const log2 = createSubsystemLogger("demo/pretty");
  log2.info("server started", { port: 3000, env: "production" });
  log2.warn("high memory usage", { heapMb: 450, limitMb: 512 });

  // --- JSON console style ---
  console.log("\n--- Console style: json ---\n");
  configureLogger({ level: "debug", consoleLevel: "debug", consoleStyle: "json" });
  const log3 = createSubsystemLogger("demo/json");
  log3.info("request processed", { method: "POST", path: "/api/run", durationMs: 142 });
  log3.error("agent failed", { sessionId: "sess-123", error: "context length exceeded" });

  // --- File output ---
  console.log("\n--- File output (JSON lines) ---\n");
  const logFile = path.join(LOG_DIR, "demo.log");
  configureLogger({ level: "debug", file: logFile, consoleLevel: "silent" });
  const log4 = createSubsystemLogger("demo/file");
  log4.info("this goes to file only");
  log4.warn("warning in file", { key: "value" });
  log4.error("error in file");
  log4.debug("debug in file");

  const content = fs.readFileSync(logFile, "utf-8");
  const lines = content.trim().split("\n");
  console.log(`  Wrote ${lines.length} lines to ${logFile}:`);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    console.log(`    [${parsed.level}] ${parsed.subsystem}: ${parsed.message}`);
  }

  // --- Child loggers ---
  console.log("\n--- Child loggers ---\n");
  configureLogger({ level: "debug", consoleLevel: "debug", consoleStyle: "compact" });
  const parent = createSubsystemLogger("memory");
  const search = parent.child("search");
  const embed = parent.child("embeddings");
  search.info("searching for: TypeScript");
  embed.debug("embedding batch: 10 chunks");

  // --- consoleMessage override ---
  console.log("\n--- consoleMessage override (different message for console vs file) ---\n");
  const log5File = path.join(LOG_DIR, "override.log");
  configureLogger({ level: "debug", file: log5File, consoleLevel: "debug", consoleStyle: "compact" });
  const log5 = createSubsystemLogger("demo/override");
  log5.info("detailed technical message with provider=openai model=gpt-4o tokens=50000", {
    consoleMessage: "agent completed successfully",
    provider: "openai",
    model: "gpt-4o",
  });

  const overrideContent = fs.readFileSync(log5File, "utf-8").trim();
  const fileLine = JSON.parse(overrideContent.split("\n")[0]);
  console.log(`  Console showed: short message`);
  console.log(`  File contains:  "${fileLine.message}" with metadata`);

  // --- Prefix stripping ---
  console.log("\n--- Subsystem prefix stripping ---\n");
  const examples = [
    { msg: "[discord] connected to gateway", sub: "discord" },
    { msg: "discord: message received", sub: "discord" },
    { msg: "telegram: polling started", sub: "discord" },
  ];
  for (const { msg, sub } of examples) {
    const stripped = stripRedundantSubsystemPrefixForConsole(msg, sub);
    console.log(`  [${sub}] "${msg}" → "${stripped}"`);
  }

  // --- Separate levels ---
  console.log("\n--- Separate file and console levels ---\n");
  const sepFile = path.join(LOG_DIR, "separate.log");
  configureLogger({ level: "debug", file: sepFile, consoleLevel: "error", consoleStyle: "compact" });
  const log6 = createSubsystemLogger("demo/levels");
  console.log("  (file level: debug, console level: error)");
  console.log("  Writing: debug, info, warn, error to file. Only error shows on console:");
  log6.debug("debug: only in file");
  log6.info("info: only in file");
  log6.warn("warn: only in file");
  log6.error("error: in both file AND console");

  const sepContent = fs.readFileSync(sepFile, "utf-8").trim().split("\n");
  console.log(`  File has ${sepContent.length} lines (should be 4)`);

  // Cleanup
  configureLogger({});
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  console.log("\nDemo complete.");
}

main();
