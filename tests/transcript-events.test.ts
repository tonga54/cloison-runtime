import { describe, it, expect } from "vitest";
import {
  onSessionTranscriptUpdate,
  emitSessionTranscriptUpdate,
} from "../src/sessions/transcript-events.js";

describe("TranscriptEvents", () => {
  it("emits string updates", () => {
    const received: string[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      received.push(update.sessionFile);
    });

    emitSessionTranscriptUpdate("/path/to/session.jsonl");
    expect(received).toEqual(["/path/to/session.jsonl"]);

    unsubscribe();
  });

  it("emits object updates with all fields", () => {
    const received: Array<{ sessionFile: string; sessionKey?: string }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      received.push(update);
    });

    emitSessionTranscriptUpdate({
      sessionFile: "/path/session.jsonl",
      sessionKey: "key-1",
      message: { role: "user" },
      messageId: "msg-1",
    });

    expect(received[0].sessionFile).toBe("/path/session.jsonl");
    expect(received[0].sessionKey).toBe("key-1");

    unsubscribe();
  });

  it("ignores empty session file", () => {
    const received: string[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      received.push(update.sessionFile);
    });

    emitSessionTranscriptUpdate("");
    emitSessionTranscriptUpdate("   ");
    expect(received).toEqual([]);

    unsubscribe();
  });

  it("unsubscribe removes listener", () => {
    const received: string[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      received.push(update.sessionFile);
    });

    emitSessionTranscriptUpdate("/a.jsonl");
    unsubscribe();
    emitSessionTranscriptUpdate("/b.jsonl");

    expect(received).toEqual(["/a.jsonl"]);
  });

  it("supports multiple listeners", () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsub1 = onSessionTranscriptUpdate((u) => a.push(u.sessionFile));
    const unsub2 = onSessionTranscriptUpdate((u) => b.push(u.sessionFile));

    emitSessionTranscriptUpdate("/test.jsonl");
    expect(a).toEqual(["/test.jsonl"]);
    expect(b).toEqual(["/test.jsonl"]);

    unsub1();
    unsub2();
  });

  it("listener errors do not break other listeners", () => {
    const received: string[] = [];
    const unsub1 = onSessionTranscriptUpdate(() => {
      throw new Error("boom");
    });
    const unsub2 = onSessionTranscriptUpdate((u) => received.push(u.sessionFile));

    emitSessionTranscriptUpdate("/test.jsonl");
    expect(received).toEqual(["/test.jsonl"]);

    unsub1();
    unsub2();
  });
});
