import { describe, it, expect } from "vitest";
import { pruneContextMessages } from "../src/runtime/session-pruning.js";

describe("pruneContextMessages", () => {
  it("does not prune when under threshold", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const { result } = pruneContextMessages(messages, { contextWindowTokens: 100000 });
    expect(result.pruned).toBe(false);
  });

  it("soft-trims old tool results when over softTrimRatio", () => {
    const bigToolResult = "x".repeat(20000);
    const messages = [
      { role: "user", content: "run a command" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "exec" },
          { type: "tool_result", tool_use_id: "t1", content: bigToolResult },
        ],
      },
      { role: "user", content: "another question" },
      { role: "assistant", content: "response" },
      { role: "user", content: "final" },
      { role: "assistant", content: "done" },
      { role: "user", content: "extra1" },
      { role: "assistant", content: "extra2" },
    ];

    const { messages: pruned, result } = pruneContextMessages(messages, {
      contextWindowTokens: 2000,
      softTrimRatio: 0.1,
    });

    expect(result.pruned).toBe(true);
    expect(result.softTrimmed + result.hardCleared).toBeGreaterThan(0);
  });

  it("preserves recent messages (last 6)", () => {
    const bigToolResult = "x".repeat(20000);
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i === 1
        ? [{ type: "tool_result", content: bigToolResult }]
        : `message ${i}`,
    }));

    const { messages: pruned } = pruneContextMessages(messages as any, {
      contextWindowTokens: 1000,
      softTrimRatio: 0.1,
    });

    expect(pruned.length).toBe(10);
    const lastMsg = pruned[pruned.length - 1];
    expect(lastMsg.content).toBe("message 9");
  });

  it("does not prune system messages", () => {
    const messages = [
      { role: "system", content: "y".repeat(50000) },
      { role: "user", content: "hello" },
    ];
    const { messages: pruned } = pruneContextMessages(messages, {
      contextWindowTokens: 1000,
      softTrimRatio: 0.01,
    });
    expect((pruned[0].content as string).length).toBe(50000);
  });
});
