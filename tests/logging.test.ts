import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createSubsystemLogger,
  configureLogger,
  levelToMinLevel,
  tryParseLogLevel,
  normalizeLogLevel,
  stripRedundantSubsystemPrefixForConsole,
} from "../src/logging/subsystem.js";

describe("SubsystemLogger", () => {
  afterEach(() => {
    configureLogger({});
  });

  it("creates a logger with subsystem name", () => {
    const log = createSubsystemLogger("test");
    expect(log.subsystem).toBe("test");
  });

  it("creates child loggers with prefixed name", () => {
    const parent = createSubsystemLogger("memory");
    const child = parent.child("search");
    expect(child.subsystem).toBe("memory/search");
  });

  it("respects file log level filtering", () => {
    configureLogger({ level: "error" });
    const log = createSubsystemLogger("test");
    expect(log.isEnabled("error", "file")).toBe(true);
    expect(log.isEnabled("warn", "file")).toBe(false);
  });

  it("writes to log file as JSON lines", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-test-"));
    const logFile = path.join(tmpDir, "test.log");
    try {
      configureLogger({ level: "debug", file: logFile, consoleLevel: "silent" });
      const log = createSubsystemLogger("test-subsystem");
      log.info("hello world", { key: "value" });
      log.error("something failed");
      log.debug("debug info");

      const content = fs.readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(3);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.level).toBe("info");
      expect(parsed.subsystem).toBe("test-subsystem");
      expect(parsed.message).toBe("hello world");
      expect(parsed.key).toBe("value");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not write filtered levels to file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-test-"));
    const logFile = path.join(tmpDir, "test.log");
    try {
      configureLogger({ level: "warn", file: logFile, consoleLevel: "silent" });
      const log = createSubsystemLogger("test");
      log.debug("should not appear");
      log.info("should not appear");
      log.warn("should appear");

      const content = fs.readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).level).toBe("warn");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("levelToMinLevel", () => {
  it("maps levels to numeric priority", () => {
    expect(levelToMinLevel("fatal")).toBe(0);
    expect(levelToMinLevel("error")).toBe(1);
    expect(levelToMinLevel("warn")).toBe(2);
    expect(levelToMinLevel("info")).toBe(3);
    expect(levelToMinLevel("trace")).toBe(5);
    expect(levelToMinLevel("silent")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("tryParseLogLevel", () => {
  it("parses valid levels", () => {
    expect(tryParseLogLevel("debug")).toBe("debug");
    expect(tryParseLogLevel("error")).toBe("error");
  });
  it("returns undefined for invalid", () => {
    expect(tryParseLogLevel("unknown")).toBeUndefined();
    expect(tryParseLogLevel(undefined)).toBeUndefined();
  });
});

describe("normalizeLogLevel", () => {
  it("returns fallback for invalid", () => {
    expect(normalizeLogLevel("unknown", "warn")).toBe("warn");
    expect(normalizeLogLevel(undefined)).toBe("info");
  });
});

describe("stripRedundantSubsystemPrefixForConsole", () => {
  it("strips bracket prefix matching subsystem", () => {
    expect(stripRedundantSubsystemPrefixForConsole("[discord] connected", "discord")).toBe("connected");
  });
  it("strips colon prefix matching subsystem", () => {
    expect(stripRedundantSubsystemPrefixForConsole("discord: connected", "discord")).toBe("connected");
  });
  it("does not strip non-matching prefix", () => {
    expect(stripRedundantSubsystemPrefixForConsole("telegram: connected", "discord")).toBe("telegram: connected");
  });
});
