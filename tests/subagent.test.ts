import { describe, it, expect } from "vitest";
import {
  createSubagentRegistry,
  spawnSubagentsParallel,
} from "../src/runtime/subagent.js";

describe("SubagentRegistry", () => {
  it("starts empty", () => {
    const registry = createSubagentRegistry();
    expect(registry.listAll()).toEqual([]);
    expect(registry.countActive()).toBe(0);
  });

  it("registers and retrieves a run", () => {
    const registry = createSubagentRegistry();
    registry.register({
      id: "sub-1",
      task: "do something",
      status: "pending",
      startedAt: Date.now(),
    });
    expect(registry.get("sub-1")).toBeDefined();
    expect(registry.get("sub-1")!.task).toBe("do something");
  });

  it("tracks active runs", () => {
    const registry = createSubagentRegistry();
    registry.register({ id: "s1", task: "a", status: "running", startedAt: Date.now() });
    registry.register({ id: "s2", task: "b", status: "completed", startedAt: Date.now() });
    registry.register({ id: "s3", task: "c", status: "pending", startedAt: Date.now() });

    expect(registry.countActive()).toBe(2);
    expect(registry.listActive().map((r) => r.id).sort()).toEqual(["s1", "s3"]);
  });

  it("updates run status", () => {
    const registry = createSubagentRegistry();
    registry.register({ id: "s1", task: "a", status: "running", startedAt: Date.now() });
    registry.update("s1", { status: "completed", response: "done" });

    expect(registry.get("s1")!.status).toBe("completed");
    expect(registry.get("s1")!.response).toBe("done");
    expect(registry.countActive()).toBe(0);
  });

  it("clears all runs", () => {
    const registry = createSubagentRegistry();
    registry.register({ id: "s1", task: "a", status: "running", startedAt: Date.now() });
    registry.register({ id: "s2", task: "b", status: "pending", startedAt: Date.now() });
    registry.clear();
    expect(registry.listAll()).toEqual([]);
  });
});

describe("spawnSubagentsParallel", () => {
  it("runs tasks in parallel", async () => {
    const order: string[] = [];

    const results = await spawnSubagentsParallel({
      tasks: [
        { id: "t1", task: "task 1" },
        { id: "t2", task: "task 2" },
        { id: "t3", task: "task 3" },
      ],
      run: async (task) => {
        order.push(task.id);
        return `result:${task.id}`;
      },
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(results.find((r) => r.id === "t1")?.response).toBe("result:t1");
  });

  it("handles errors in individual tasks", async () => {
    const results = await spawnSubagentsParallel({
      tasks: [
        { id: "t1", task: "ok" },
        { id: "t2", task: "fail" },
      ],
      run: async (task) => {
        if (task.task === "fail") throw new Error("oops");
        return "success";
      },
    });

    expect(results.find((r) => r.id === "t1")?.status).toBe("completed");
    expect(results.find((r) => r.id === "t2")?.status).toBe("error");
    expect(results.find((r) => r.id === "t2")?.error).toContain("oops");
  });

  it("respects concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const results = await spawnSubagentsParallel({
      tasks: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, task: `task ${i}` })),
      maxConcurrent: 2,
      run: async (task) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return `done:${task.id}`;
      },
    });

    expect(results).toHaveLength(6);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("rejects on depth limit", async () => {
    await expect(
      spawnSubagentsParallel({
        tasks: [{ id: "t1", task: "deep" }],
        currentDepth: 5,
        run: async () => "ok",
      }),
    ).rejects.toThrow("depth limit");
  });

  it("calls onResult callback", async () => {
    const received: string[] = [];
    await spawnSubagentsParallel({
      tasks: [
        { id: "t1", task: "a" },
        { id: "t2", task: "b" },
      ],
      run: async (t) => t.task,
      onResult: (result) => received.push(result.id),
    });
    expect(received.sort()).toEqual(["t1", "t2"]);
  });

  it("returns empty for no tasks", async () => {
    const results = await spawnSubagentsParallel({
      tasks: [],
      run: async () => "ok",
    });
    expect(results).toEqual([]);
  });
});
