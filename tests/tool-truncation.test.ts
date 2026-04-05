import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  truncateToolResultText,
  calculateMaxToolResultChars,
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInMessages,
  truncateOversizedToolResultsInSession,
} from "../src/runtime/tool-result-truncation.js";

describe("calculateMaxToolResultChars", () => {
  it("calculates 30% of context window in chars", () => {
    const maxChars = calculateMaxToolResultChars(128000);
    expect(maxChars).toBe(128000 * 4 * 0.3);
  });

  it("caps at 400K chars", () => {
    const maxChars = calculateMaxToolResultChars(1000000);
    expect(maxChars).toBe(400000);
  });
});

describe("truncateToolResultText", () => {
  it("returns short text unchanged", () => {
    expect(truncateToolResultText("hello", 1000)).toBe("hello");
  });

  it("truncates long text with head+tail", () => {
    const long = "a".repeat(10000);
    const truncated = truncateToolResultText(long, 1000);
    expect(truncated.length).toBeLessThan(10000);
    expect(truncated).toContain("truncated");
    expect(truncated.startsWith("aaa")).toBe(true);
    expect(truncated.endsWith("aaa")).toBe(true);
  });
});

describe("sessionLikelyHasOversizedToolResults", () => {
  it("detects oversized tool results", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_result", content: "x".repeat(200000) },
        ],
      },
    ];
    expect(sessionLikelyHasOversizedToolResults({
      messages,
      contextWindowTokens: 32000,
    })).toBe(true);
  });

  it("returns false for normal-sized results", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_result", content: "small result" },
        ],
      },
    ];
    expect(sessionLikelyHasOversizedToolResults({
      messages,
      contextWindowTokens: 128000,
    })).toBe(false);
  });
});

describe("truncateOversizedToolResultsInMessages", () => {
  it("truncates oversized results", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_result", content: "x".repeat(200000) },
        ],
      },
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      32000,
    );
    expect(truncatedCount).toBe(1);
    const block = (result[0].content as any[])[0];
    expect(block.content.length).toBeLessThan(200000);
    expect(block.content).toContain("truncated");
  });

  it("leaves normal results unchanged", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_result", content: "ok" }] },
    ];
    const { truncatedCount } = truncateOversizedToolResultsInMessages(messages, 128000);
    expect(truncatedCount).toBe(0);
  });
});

describe("truncateOversizedToolResultsInSession", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("truncates oversized results in session file", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trunc-test-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");

    const bigResult = "x".repeat(200000);
    const lines = [
      JSON.stringify({ role: "user", content: "run a big command" }),
      JSON.stringify({ role: "assistant", content: [{ type: "tool_result", content: bigResult }] }),
    ];
    fs.writeFileSync(sessionFile, lines.join("\n"));

    const { truncated, truncatedCount } = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 32000,
    });

    expect(truncated).toBe(true);
    expect(truncatedCount).toBe(1);

    const newContent = fs.readFileSync(sessionFile, "utf-8");
    expect(newContent.length).toBeLessThan(lines.join("\n").length);
  });
});
