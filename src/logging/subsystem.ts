// Ported from OpenClaw src/logging/logger.ts + subsystem.ts + levels.ts
// Removed: tslog, chalk, external transport system, loggingState global, pino adapter
// Kept: rolling log files by date, stale pruning, size cap, console styles, level filtering

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- Levels (from levels.ts) ---

export const ALLOWED_LOG_LEVELS = [
  "silent", "fatal", "error", "warn", "info", "debug", "trace",
] as const;

export type LogLevel = (typeof ALLOWED_LOG_LEVELS)[number];

export function tryParseLogLevel(level?: string): LogLevel | undefined {
  if (typeof level !== "string") return undefined;
  const candidate = level.trim();
  return ALLOWED_LOG_LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : undefined;
}

export function normalizeLogLevel(level?: string, fallback: LogLevel = "info"): LogLevel {
  return tryParseLogLevel(level) ?? fallback;
}

export function levelToMinLevel(level: LogLevel): number {
  const map: Record<LogLevel, number> = {
    fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5,
    silent: Number.POSITIVE_INFINITY,
  };
  return map[level];
}

// --- Logger config ---

export interface LoggerConfig {
  level?: LogLevel;
  file?: string;
  maxFileBytes?: number;
  json?: boolean;
  consoleLevel?: LogLevel;
  consoleStyle?: "pretty" | "compact" | "json";
}

export type SubsystemLogger = {
  subsystem: string;
  isEnabled: (level: LogLevel, target?: "any" | "console" | "file") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => void;
  raw: (message: string) => void;
  child: (name: string) => SubsystemLogger;
};

// --- Rolling log files (from logger.ts) ---

const LOG_PREFIX = "cloison-runtime";
const LOG_SUFFIX = ".log";
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LOG_FILE_BYTES = 500 * 1024 * 1024;

function resolveDefaultLogDir(): string {
  return path.join(os.tmpdir(), "cloison-runtime-logs");
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultRollingPathForToday(): string {
  return path.join(resolveDefaultLogDir(), `${LOG_PREFIX}-${formatLocalDate(new Date())}${LOG_SUFFIX}`);
}

function isRollingPath(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) fs.rmSync(fullPath, { force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// --- Global state ---

let globalConfig: LoggerConfig = {};
let logFd: number | null = null;
let logFilePath: string | null = null;
let currentFileBytes = 0;
let warnedAboutSizeCap = false;

export function configureLogger(config: LoggerConfig): void {
  globalConfig = { ...config };
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch { /* best effort */ }
    logFd = null;
  }
  logFilePath = null;
  currentFileBytes = 0;
  warnedAboutSizeCap = false;
}

function getFileLevel(): LogLevel {
  if (globalConfig.level) return globalConfig.level;
  const env = process.env["CLOISON_LOG_LEVEL"] ?? process.env["LOG_LEVEL"] ?? "";
  return tryParseLogLevel(env) ?? "info";
}

function getConsoleLevel(): LogLevel {
  if (globalConfig.consoleLevel) return globalConfig.consoleLevel;
  const env = process.env["CLOISON_CONSOLE_LOG_LEVEL"] ?? "";
  return tryParseLogLevel(env) ?? "warn";
}

function getConsoleStyle(): "pretty" | "compact" | "json" {
  return globalConfig.consoleStyle ?? (globalConfig.json ? "json" : "compact");
}

function resolveLogFile(): string {
  return globalConfig.file ?? process.env["CLOISON_LOG_FILE"] ?? defaultRollingPathForToday();
}

function getMaxFileBytes(): number {
  if (typeof globalConfig.maxFileBytes === "number" && globalConfig.maxFileBytes > 0) {
    return Math.floor(globalConfig.maxFileBytes);
  }
  return DEFAULT_MAX_LOG_FILE_BYTES;
}

function shouldLogToFile(level: LogLevel): boolean {
  const minLevel = getFileLevel();
  if (minLevel === "silent") return false;
  return levelToMinLevel(level) <= levelToMinLevel(minLevel);
}

function shouldLogToConsole(level: LogLevel): boolean {
  const minLevel = getConsoleLevel();
  if (minLevel === "silent") return false;
  return levelToMinLevel(level) <= levelToMinLevel(minLevel);
}

// --- File output ---

function ensureLogFd(): number | null {
  const filePath = resolveLogFile();
  if (logFd !== null && logFilePath === filePath) return logFd;
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch { /* best effort */ }
  }

  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (isRollingPath(filePath)) pruneOldRollingLogs(dir);
    try {
      currentFileBytes = fs.statSync(filePath).size;
    } catch {
      currentFileBytes = 0;
    }
    logFd = fs.openSync(filePath, "a", 0o600);
    logFilePath = filePath;
    warnedAboutSizeCap = false;
    return logFd;
  } catch {
    return null;
  }
}

function appendToFile(line: string): void {
  const fd = ensureLogFd();
  if (fd === null) return;

  const maxBytes = getMaxFileBytes();
  const payload = line + "\n";
  const payloadBytes = Buffer.byteLength(payload);
  const nextBytes = currentFileBytes + payloadBytes;

  if (nextBytes > maxBytes) {
    if (!warnedAboutSizeCap) {
      warnedAboutSizeCap = true;
      const warningLine = JSON.stringify({
        time: new Date().toISOString(),
        level: "warn",
        subsystem: "logging",
        message: `log file size cap reached; suppressing writes file=${logFilePath} maxFileBytes=${maxBytes}`,
      });
      try {
        fs.writeSync(fd, warningLine + "\n");
      } catch { /* ignore */ }
    }
    return;
  }

  try {
    fs.writeSync(fd, payload);
    currentFileBytes = nextBytes;
  } catch { /* never block on logging failures */ }
}

// --- Console formatting (from subsystem.ts) ---

const SUBSYSTEM_MAX_SEGMENTS = 2;

function formatSubsystemForConsole(subsystem: string): string {
  const parts = subsystem.split("/").filter(Boolean);
  if (parts.length === 0) return subsystem;
  if (parts.length > SUBSYSTEM_MAX_SEGMENTS) {
    return parts.slice(-SUBSYSTEM_MAX_SEGMENTS).join("/");
  }
  return parts.join("/");
}

export function stripRedundantSubsystemPrefixForConsole(
  message: string,
  displaySubsystem: string,
): string {
  if (!displaySubsystem) return message;

  if (message.startsWith("[")) {
    const closeIdx = message.indexOf("]");
    if (closeIdx > 1) {
      const bracketTag = message.slice(1, closeIdx);
      if (bracketTag.toLowerCase() === displaySubsystem.toLowerCase()) {
        let i = closeIdx + 1;
        while (message[i] === " ") i += 1;
        return message.slice(i);
      }
    }
  }

  const prefix = message.slice(0, displaySubsystem.length);
  if (prefix.toLowerCase() !== displaySubsystem.toLowerCase()) return message;

  const next = message.slice(displaySubsystem.length, displaySubsystem.length + 1);
  if (next !== ":" && next !== " ") return message;

  let i = displaySubsystem.length;
  while (message[i] === " ") i += 1;
  if (message[i] === ":") i += 1;
  while (message[i] === " ") i += 1;
  return message.slice(i);
}

function formatConsoleLine(opts: {
  level: LogLevel;
  subsystem: string;
  message: string;
  style: "pretty" | "compact" | "json";
  meta?: Record<string, unknown>;
}): string {
  const displaySubsystem =
    opts.style === "json" ? opts.subsystem : formatSubsystemForConsole(opts.subsystem);

  if (opts.style === "json") {
    return JSON.stringify({
      time: new Date().toISOString(),
      level: opts.level,
      subsystem: displaySubsystem,
      message: opts.message,
      ...opts.meta,
    });
  }

  const time = new Date().toISOString();
  const levelTag = opts.level.toUpperCase().padEnd(5);
  const displayMessage = stripRedundantSubsystemPrefixForConsole(opts.message, displaySubsystem);
  const metaSuffix =
    opts.meta && Object.keys(opts.meta).length > 0 ? ` ${JSON.stringify(opts.meta)}` : "";

  if (opts.style === "pretty") {
    return `${time} [${levelTag}] [${displaySubsystem}] ${displayMessage}${metaSuffix}`;
  }

  return `[${displaySubsystem}] ${displayMessage}${metaSuffix}`;
}

function writeConsoleLine(level: LogLevel, line: string): void {
  if (level === "error" || level === "fatal") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// --- SubsystemLogger factory ---

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  const buildEmitter = (level: LogLevel) => {
    return (message: string, meta?: Record<string, unknown>) => {
      const fileEnabled = shouldLogToFile(level);
      const consoleEnabled = shouldLogToConsole(level);
      if (!fileEnabled && !consoleEnabled) return;

      let consoleMessageOverride: string | undefined;
      let fileMeta = meta;
      if (meta && Object.keys(meta).length > 0) {
        const { consoleMessage, ...rest } = meta as Record<string, unknown> & { consoleMessage?: unknown };
        if (typeof consoleMessage === "string") consoleMessageOverride = consoleMessage;
        fileMeta = Object.keys(rest).length > 0 ? rest : undefined;
      }

      if (fileEnabled) {
        const jsonLine = JSON.stringify({
          time: new Date().toISOString(),
          level,
          subsystem,
          message,
          ...(fileMeta && Object.keys(fileMeta).length > 0 ? fileMeta : {}),
        });
        appendToFile(jsonLine);
      }

      if (consoleEnabled) {
        const consoleMsg = consoleMessageOverride ?? message;
        writeConsoleLine(
          level,
          formatConsoleLine({
            level,
            subsystem,
            message: getConsoleStyle() === "json" ? message : consoleMsg,
            style: getConsoleStyle(),
            meta: fileMeta,
          }),
        );
      }
    };
  };

  return {
    subsystem,
    isEnabled(level, target = "any") {
      if (target === "console") return shouldLogToConsole(level);
      if (target === "file") return shouldLogToFile(level);
      return shouldLogToConsole(level) || shouldLogToFile(level);
    },
    trace: buildEmitter("trace"),
    debug: buildEmitter("debug"),
    info: buildEmitter("info"),
    warn: buildEmitter("warn"),
    error: buildEmitter("error"),
    fatal: buildEmitter("fatal"),
    raw(message) {
      if (shouldLogToFile("info")) appendToFile(message);
      if (shouldLogToConsole("info")) writeConsoleLine("info", message);
    },
    child(name) {
      return createSubsystemLogger(`${subsystem}/${name}`);
    },
  };
}
