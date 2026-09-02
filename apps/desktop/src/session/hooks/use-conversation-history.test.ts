import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyConversationEntriesPatches,
  loadHistoricTaskRunEntries,
} from "./use-conversation-history";

const assistantPatch = (
  op: "add" | "replace",
  index: number,
  content: string,
) => ({
  op,
  path: `/entries/${index}`,
  value: {
    type: "NORMALIZED_ENTRY" as const,
    content: {
      type: { type: "assistant_message" },
      content,
    },
  },
});

describe("applyConversationEntriesPatches", () => {
  it("upserts cumulative replaces when retained history starts after the add", () => {
    const runId = "long-running-codex-run";
    let entries = applyConversationEntriesPatches(
      [],
      [assistantPatch("replace", 5204, "disk quota 引数の抑止")],
      runId,
    );
    entries = applyConversationEntriesPatches(
      entries,
      [assistantPatch("replace", 5204, "disk quota 引数の抑止を")],
      runId,
    );
    entries = applyConversationEntriesPatches(
      entries,
      [assistantPatch("replace", 5204, "disk quota 引数の抑止を実装します。")],
      runId,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "NORMALIZED_ENTRY",
      key: `${runId}:stream-entry:5204`,
      content: {
        content: "disk quota 引数の抑止を実装します。",
      },
    });
  });

  it("keeps sparse and out-of-order server indices in conversation order", () => {
    const runId = "reconnected-run";
    let entries = applyConversationEntriesPatches(
      [],
      [assistantPatch("replace", 12, "third")],
      runId,
    );
    entries = applyConversationEntriesPatches(
      entries,
      [assistantPatch("add", 10, "first")],
      runId,
    );
    entries = applyConversationEntriesPatches(
      entries,
      [assistantPatch("replace", 11, "second")],
      runId,
    );

    expect(entries).toHaveLength(3);
    expect(
      entries.map((entry) =>
        entry.type === "NORMALIZED_ENTRY" ? entry.content.content : null,
      ),
    ).toEqual(["first", "second", "third"]);
  });

  it("treats a replayed add for an existing server index as an upsert", () => {
    const runId = "replayed-run";
    let entries = applyConversationEntriesPatches(
      [],
      [assistantPatch("add", 7, "partial")],
      runId,
    );
    entries = applyConversationEntriesPatches(
      entries,
      [assistantPatch("add", 7, "authoritative")],
      runId,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "NORMALIZED_ENTRY",
      content: { content: "authoritative" },
    });
  });
});

/**
 * Minimal WebSocket stand-in driven manually by each test. Only the surface
 * `loadHistoricTaskRunEntries` touches is implemented.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no FakeWebSocket constructed");
    return ws;
  }

  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { wasClean: boolean }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const replayedPatch = (index: number, content: string) => ({
  JsonPatch: [assistantPatch("add", index, content)],
});

describe("loadHistoricTaskRunEntries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("is authoritative when the server sends the finished marker", async () => {
    const promise = loadHistoricTaskRunEntries("run-1");
    const ws = FakeWebSocket.latest();

    ws.message(replayedPatch(0, "hello"));
    ws.message({ finished: true });

    const result = await promise;
    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(ws.closed).toBe(true);
  });

  it("is authoritative on a clean close without a finished marker", async () => {
    const promise = loadHistoricTaskRunEntries("run-1");
    const ws = FakeWebSocket.latest();

    ws.onclose?.({ wasClean: true });

    const result = await promise;
    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(0);
  });

  it("reports an unclean close as incomplete, keeping partial entries", async () => {
    const promise = loadHistoricTaskRunEntries("run-1");
    const ws = FakeWebSocket.latest();

    ws.message(replayedPatch(0, "partial"));
    ws.onclose?.({ wasClean: false });

    const result = await promise;
    expect(result.complete).toBe(false);
    expect(result.entries).toHaveLength(1);
  });

  it("reports a socket error as incomplete", async () => {
    const promise = loadHistoricTaskRunEntries("run-1");
    const ws = FakeWebSocket.latest();

    ws.onerror?.();

    const result = await promise;
    expect(result.complete).toBe(false);
  });

  it("gives up as incomplete after true silence, never as an empty history", async () => {
    const promise = loadHistoricTaskRunEntries("run-1");
    const ws = FakeWebSocket.latest();

    await vi.advanceTimersByTimeAsync(30_000);

    const result = await promise;
    expect(result.complete).toBe(false);
    expect(result.entries).toHaveLength(0);
    expect(ws.closed).toBe(true);
  });

  it("re-arms the idle deadline on every message, including liveness markers", async () => {
    const promise = loadHistoricTaskRunEntries("run-1");
    const ws = FakeWebSocket.latest();

    await vi.advanceTimersByTimeAsync(29_000);
    ws.message({ replayStarted: true });
    // Past the original deadline, but within the re-armed one.
    await vi.advanceTimersByTimeAsync(29_000);
    ws.message(replayedPatch(0, "late but alive"));
    ws.message({ finished: true });

    const result = await promise;
    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(1);
  });
});
