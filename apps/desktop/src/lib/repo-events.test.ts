import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type RepoEventsConfig,
  repoEventMatches,
  subscribeRepoEvents,
} from "./repo-events";

/** Mirrored behavioral contract constants. */
const INVALIDATE_DEBOUNCE_MS = 300;
const RECONNECT_DELAY_MS = 1_000;

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

  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: code ?? 1005, wasClean: code === 1000 });
  }

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

/** A unique endpoint per test so module-level registry state never collides. */
let counter = 0;
function uniqueEndpoint(): string {
  counter += 1;
  return `http://host/repo-events-${counter}`;
}

const repoEvent = (payload: unknown) => ({ type: "repo_event", payload });

function setup(config?: Partial<RepoEventsConfig>) {
  const onInvalidate = vi.fn();
  const endpoint = uniqueEndpoint();
  const dispose = subscribeRepoEvents(endpoint, () => ({
    channels: ["files", "git"],
    onInvalidate,
    ...config,
  }));
  FakeWebSocket.last().driveOpen();
  return { onInvalidate, dispose, socket: FakeWebSocket.last() };
}

describe("subscribeRepoEvents", () => {
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

  it("debounces an event burst into one invalidation", () => {
    const { onInvalidate, dispose, socket } = setup();

    socket.driveMessage(repoEvent({ channel: "files", paths: ["a.md"] }));
    socket.driveMessage(repoEvent({ channel: "files", paths: ["b.md"] }));
    socket.driveMessage(repoEvent({ channel: "git", kinds: ["headMoved"] }));
    expect(onInvalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not invalidate on the first connect, but does on reconnect", () => {
    const { onInvalidate, dispose, socket } = setup();

    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).not.toHaveBeenCalled();

    // Unclean drop → registry reconnects → resync refresh.
    socket.driveServerClose(1006, false);
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    FakeWebSocket.last().driveOpen();
    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("applies the path filter, treating omitted paths as match-all", () => {
    const { onInvalidate, dispose, socket } = setup({
      pathFilter: (path) => path.endsWith(".md"),
    });

    socket.driveMessage(repoEvent({ channel: "files", paths: ["src/app.ts"] }));
    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).not.toHaveBeenCalled();

    socket.driveMessage(repoEvent({ channel: "files" }));
    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("filters git kinds and unrequested channels", () => {
    const { onInvalidate, dispose, socket } = setup({
      channels: ["git"],
      gitKinds: ["headMoved"],
    });

    socket.driveMessage(repoEvent({ channel: "files", paths: ["a.md"] }));
    socket.driveMessage(repoEvent({ channel: "git", kinds: ["indexChanged"] }));
    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).not.toHaveBeenCalled();

    socket.driveMessage(repoEvent({ channel: "git", kinds: ["headMoved"] }));
    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("treats resync as an unconditional invalidation", () => {
    const { onInvalidate, dispose, socket } = setup({
      channels: ["git"],
      pathFilter: () => false,
    });

    socket.driveMessage(repoEvent({ channel: "resync" }));
    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("stops invalidating after dispose", () => {
    const { onInvalidate, dispose, socket } = setup();

    socket.driveMessage(repoEvent({ channel: "files", paths: ["a.md"] }));
    dispose();
    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it("ignores malformed payloads", () => {
    const { onInvalidate, dispose, socket } = setup();

    socket.driveMessage(repoEvent(null));
    socket.driveMessage(repoEvent({ channel: "unknown" }));
    socket.driveMessage({ type: "ui_event", payload: { kind: "x" } });
    vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
    expect(onInvalidate).not.toHaveBeenCalled();
    dispose();
  });
});

describe("repoEventMatches", () => {
  const base: RepoEventsConfig = {
    channels: ["files"],
    onInvalidate: () => {},
  };

  it("matches files only when the channel is requested", () => {
    expect(
      repoEventMatches({ channel: "files", paths: ["a"] }, base),
    ).toBe(true);
    expect(
      repoEventMatches(
        { channel: "git", kinds: ["headMoved"] },
        base,
      ),
    ).toBe(false);
  });
});
