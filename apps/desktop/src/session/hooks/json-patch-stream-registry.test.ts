import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type StreamSubscriber,
  acquireStream,
  getStreamSnapshot,
} from "./json-patch-stream-registry";

/** Behavioral contract constant mirrored from the registry. */
const TEARDOWN_GRACE_MS = 5_000;
const FIRST_MESSAGE_TIMEOUT_MS = 15_000;

/** Controllable WebSocket double: tests drive open/message/close explicitly. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code?: number; wasClean?: boolean }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /** The registry calls this on watchdog timeout and on teardown. Mirrors a
   * browser firing `onclose` after `close()` when the handler is still set. */
  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: code ?? 1005, wasClean: code === 1000 });
  }

  // --- test drivers ---
  driveOpen(): void {
    this.onopen?.();
  }
  driveMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  driveServerClose(code: number, wasClean: boolean): void {
    this.onclose?.({ code, wasClean });
  }

  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no FakeWebSocket created");
    return ws;
  }
}

function makeSubscriber(): StreamSubscriber & { notifyCount: number } {
  const subscriber = {
    notifyCount: 0,
    notify: () => {
      subscriber.notifyCount += 1;
    },
    getOptions: () => undefined,
  };
  return subscriber;
}

const initialData = () => ({ tasks: {} as Record<string, unknown> });

/** A unique endpoint per test so module-level registry state never collides. */
let counter = 0;
function uniqueEndpoint(): string {
  counter += 1;
  return `http://host/stream-${counter}`;
}

const snapshotReplace = (tasks: Record<string, unknown>) => ({
  type: "json_patch",
  payload: [{ op: "replace", path: "/tasks", value: tasks }],
});

describe("json-patch-stream-registry", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens exactly one socket for two consumers of the same endpoint", () => {
    const endpoint = uniqueEndpoint();
    acquireStream(endpoint, initialData, makeSubscriber());
    acquireStream(endpoint, initialData, makeSubscriber());
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("opens separate sockets for different endpoints", () => {
    acquireStream(uniqueEndpoint(), initialData, makeSubscriber());
    acquireStream(uniqueEndpoint(), initialData, makeSubscriber());
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("applies the snapshot patch and exposes the data", () => {
    const endpoint = uniqueEndpoint();
    acquireStream(endpoint, initialData, makeSubscriber());
    expect(getStreamSnapshot(endpoint).data).toBeUndefined(); // loading

    FakeWebSocket.last().driveOpen();
    FakeWebSocket.last().driveMessage(snapshotReplace({ t1: { id: "t1" } }));
    vi.advanceTimersByTime(0); // flush setTimeout(0)

    expect(getStreamSnapshot(endpoint).data).toEqual({
      tasks: { t1: { id: "t1" } },
    });
    expect(getStreamSnapshot(endpoint).isConnected).toBe(true);
  });

  it("gives a late-joining consumer the current data immediately, on the same socket", () => {
    const endpoint = uniqueEndpoint();
    acquireStream(endpoint, initialData, makeSubscriber());
    FakeWebSocket.last().driveOpen();
    FakeWebSocket.last().driveMessage(snapshotReplace({ t1: { id: "t1" } }));
    vi.advanceTimersByTime(0);

    const late = makeSubscriber();
    acquireStream(endpoint, initialData, late);

    expect(FakeWebSocket.instances).toHaveLength(1); // no second connection
    expect(getStreamSnapshot(endpoint).data).toEqual({
      tasks: { t1: { id: "t1" } },
    });
  });

  it("ref-counts: the socket survives until the last consumer leaves, then tears down after a grace window", () => {
    const endpoint = uniqueEndpoint();
    const releaseA = acquireStream(endpoint, initialData, makeSubscriber());
    const releaseB = acquireStream(endpoint, initialData, makeSubscriber());
    const ws = FakeWebSocket.last();
    ws.driveOpen();

    releaseA();
    expect(ws.closed).toBe(false); // one consumer remains

    releaseB();
    expect(ws.closed).toBe(false); // grace window not yet elapsed

    vi.advanceTimersByTime(TEARDOWN_GRACE_MS);
    expect(ws.closed).toBe(true);
    expect(getStreamSnapshot(endpoint).data).toBeUndefined(); // entry removed
  });

  it("survives a StrictMode unmount→remount within the grace window without reconnecting", () => {
    const endpoint = uniqueEndpoint();
    const release = acquireStream(endpoint, initialData, makeSubscriber());
    FakeWebSocket.last().driveOpen();

    release(); // StrictMode unmount schedules teardown
    acquireStream(endpoint, initialData, makeSubscriber()); // remount cancels it

    vi.advanceTimersByTime(TEARDOWN_GRACE_MS + 1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last().closed).toBe(false);
  });

  it("reconnects with backoff after an unclean close while consumers remain", () => {
    const endpoint = uniqueEndpoint();
    acquireStream(endpoint, initialData, makeSubscriber());
    FakeWebSocket.last().driveOpen();

    FakeWebSocket.last().driveServerClose(1006, false);
    expect(getStreamSnapshot(endpoint).isConnected).toBe(false);

    vi.advanceTimersByTime(1000); // first backoff step
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not reconnect after a clean finish", () => {
    const endpoint = uniqueEndpoint();
    acquireStream(endpoint, initialData, makeSubscriber());
    FakeWebSocket.last().driveOpen();
    FakeWebSocket.last().driveMessage({ type: "finished" });

    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("surfaces an error when the first message never arrives (watchdog)", () => {
    const endpoint = uniqueEndpoint();
    acquireStream(endpoint, initialData, makeSubscriber());
    FakeWebSocket.last().driveOpen();

    vi.advanceTimersByTime(FIRST_MESSAGE_TIMEOUT_MS);
    expect(getStreamSnapshot(endpoint).error).toBe(
      "Stream stalled: no data received",
    );
  });
});
