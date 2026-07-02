/**
 * Shared, ref-counted registry for JSON-Patch WebSocket streams.
 *
 * One WebSocket per distinct endpoint URL, shared by every consumer regardless
 * of where it sits in the component tree. This replaces the previous
 * one-socket-per-hook-instance model, which opened a duplicate connection for
 * every component that subscribed to the same stream (and doubled again under
 * React StrictMode). The redundant connections were never drained by the
 * client, so their initial-snapshot send stalled the backend's 15s watchdog and
 * flipped the whole session list to "loading".
 *
 * The connection lifecycle (open, reconnect backoff, first-message watchdog,
 * patch application, teardown) lives here, keyed by endpoint. React reads an
 * immutable snapshot via `useSyncExternalStore`. Consequences that matter:
 * - A second consumer joining an already-connected stream sees the current data
 *   immediately — no second snapshot, no second loading flash.
 * - A consumer unmounting only drops its ref; it never resets the shared state
 *   (the root cause of the old "all sessions flip to loading" bug).
 * - Ref-count + a short teardown grace window absorb StrictMode's
 *   mount→unmount→remount and fast navigation, so neither re-opens the socket.
 */
import { applyPatch } from "rfc6902";
import type { Operation } from "rfc6902";
import { dedupeJsonPatchOperations } from "../utils/json-patch-stream";

/** Message envelope sent by the Chro server over a stream socket. */
export type LogEntryMessage =
  | { type: "json_patch"; payload: Operation[] }
  | { type: "stdout"; payload: string }
  | { type: "stderr"; payload: string }
  | { type: "session_id"; payload: string }
  | { type: "ui_event"; payload: { kind: string; data?: unknown } }
  | { type: "user_prompt"; payload: string }
  | { type: "finished" };

export interface UseJsonPatchWsStreamOptions<T = unknown> {
  /** Called with each non-patch message (stdout, stderr, session_id, etc.) */
  onMessage?: (msg: LogEntryMessage) => void;
  /** Called once when the finished event is received */
  onFinished?: () => void;
  /** Called on connection error */
  onError?: (error: string) => void;
  /** Called on successful connection */
  onConnect?: () => void;
  /**
   * Whether a healthy backend is expected to send a message (the initial
   * snapshot) shortly after connecting. True for snapshot streams, where a long
   * silence means a stalled/half-open connection that must be force-reconnected.
   * Set false for event-bus streams that are legitimately idle for long stretches
   * (e.g. `/rpc/events`), so they are not torn down and reconnected on silence.
   * Defaults to true. Read once, when the shared stream is first created.
   */
  expectInitialMessage?: boolean;
}

/**
 * Immutable view handed to consumers. The same reference is returned between
 * changes so `useSyncExternalStore` can skip re-renders.
 */
export interface JsonPatchStreamSnapshot<T> {
  data: T | undefined;
  error: string | null;
  isConnected: boolean;
}

/** Stable snapshot returned to disabled / keyless consumers. */
export const DISABLED_SNAPSHOT: JsonPatchStreamSnapshot<never> = {
  data: undefined,
  error: null,
  isConnected: false,
};

export interface StreamSubscriber {
  /** `useSyncExternalStore` re-render notifier. */
  notify: () => void;
  /** Reads the consumer's latest callbacks (may change between renders). */
  getOptions: () => UseJsonPatchWsStreamOptions | undefined;
}

/**
 * Timer handle type that works under both the DOM and `@types/node` libs (the
 * latter is present for build scripts). Bare `setTimeout` resolves to the node
 * overload returning `Timeout`, not `number`, so the fields must match it.
 */
type TimerId = ReturnType<typeof setTimeout>;

interface StreamEntry {
  /** Original (http/https) endpoint — the registry key and logical identity. */
  endpoint: string;
  socket: WebSocket | null;
  /** Patch target document; seeded from the first acquirer's `initialData()`. */
  document: object;
  /** Exposed data: `undefined` until the first snapshot/patch arrives. */
  exposed: object | undefined;
  error: string | null;
  isConnected: boolean;
  finished: boolean;
  subscribers: Set<StreamSubscriber>;
  pendingOps: Operation[];
  flushTimer: TimerId | null;
  firstMessageTimer: TimerId | null;
  /**
   * Watchdog for the connect phase: armed when the socket is created, cleared
   * the moment `onopen` fires. The first-message watchdog can only be armed
   * inside `onopen`, so it never covers an upgrade that hangs without opening.
   */
  connectTimer: TimerId | null;
  firstMessageSeen: boolean;
  /** Whether to arm the first-message stall watchdog (see options field). */
  expectInitialMessage: boolean;
  /** True once `onopen` has fired at least once; disables the initial-connect cap. */
  everConnected: boolean;
  retryTimer: TimerId | null;
  retryCount: number;
  teardownTimer: TimerId | null;
  /** Cached snapshot; a new reference is created only on a real change. */
  snapshot: JsonPatchStreamSnapshot<unknown>;
}

/**
 * How long to wait, after the socket opens, for the server's first message
 * (normally the initial snapshot). A healthy backend produces it almost
 * immediately even when empty, so a long silence means the connection is
 * half-open or the backend is stalled. We surface an error and force a
 * reconnect rather than leaving consumers — whose loading state is
 * `!data && !error` — spinning forever. Guards the first message only.
 */
const FIRST_MESSAGE_TIMEOUT_MS = 15_000;
/**
 * How long to wait, after creating the socket, for `onopen`. A WebSocket upgrade
 * to a healthy backend completes near-instantly; a long silence means the
 * upgrade is hung — most often the backend blocked resolving the id while the
 * DB is locked, so it never returns the `101` that fires `onopen`. The
 * first-message watchdog can't help (it is only armed *inside* `onopen`), so
 * without this a consumer — whose loading state is `!data && !error` — spins
 * forever with no recovery. On timeout we surface an error (flips loading off)
 * and force-close so `onclose` runs the normal reconnect/give-up path.
 */
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 8_000;
/**
 * How many times to retry an endpoint that has NEVER connected before giving up.
 * A handshake that is rejected (HTTP 404 for a deleted/unknown id, connection
 * refused) closes without ever firing `onopen`; retrying it forever lets a
 * single dangling subscription storm the server with failed handshakes. Once a
 * socket has connected at least once, this cap no longer applies and reconnects
 * continue indefinitely, so transient drops (e.g. a server restart) still
 * recover.
 */
const MAX_INITIAL_CONNECT_ATTEMPTS = 5;
/**
 * Keep an idle (zero-subscriber) stream alive briefly before tearing it down,
 * to absorb StrictMode's mount→unmount→remount and fast navigation away-and-back.
 */
const TEARDOWN_GRACE_MS = 5_000;

const registry = new Map<string, StreamEntry>();

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

function clearTimer(id: TimerId | null): null {
  if (id !== null) clearTimeout(id);
  return null;
}

/** Recompute the cached snapshot and notify every subscriber. */
function publish(entry: StreamEntry): void {
  entry.snapshot = {
    data: entry.exposed,
    error: entry.error,
    isConnected: entry.isConnected,
  };
  for (const sub of entry.subscribers) sub.notify();
}

/** Apply buffered patches as one batch, then publish if anything changed. */
function flush(entry: StreamEntry): void {
  entry.flushTimer = null;
  const patches = dedupeJsonPatchOperations(entry.pendingOps);
  entry.pendingOps = [];
  if (!patches.length) return;
  const next = structuredClone(entry.document);
  applyPatch(next, patches);
  entry.document = next;
  entry.exposed = next;
  publish(entry);
}

function openSocket(entry: StreamEntry): void {
  entry.firstMessageSeen = false;
  const ws = new WebSocket(httpToWs(entry.endpoint));
  entry.socket = ws;

  // Connect-phase watchdog: a hung upgrade never fires `onopen`, so the
  // first-message watchdog (armed in `onopen`) would never run. Bound the
  // connect phase here so a never-opening socket can't strand consumers in a
  // permanent loading state.
  entry.connectTimer = clearTimer(entry.connectTimer);
  if (entry.expectInitialMessage) {
    entry.connectTimer = setTimeout(() => {
      entry.connectTimer = null;
      if (entry.socket !== ws || entry.isConnected) return;
      entry.error = "Stream connect timed out";
      publish(entry);
      // Closing a still-connecting socket triggers onclose, which schedules a
      // backed-off reconnect (or gives up after the initial-connect cap).
      ws.close();
    }, CONNECT_TIMEOUT_MS);
  }

  ws.onopen = () => {
    entry.isConnected = true;
    entry.error = null;
    entry.retryCount = 0;
    entry.everConnected = true;
    entry.retryTimer = clearTimer(entry.retryTimer);
    entry.connectTimer = clearTimer(entry.connectTimer);
    entry.firstMessageTimer = clearTimer(entry.firstMessageTimer);
    if (entry.expectInitialMessage) {
      entry.firstMessageTimer = setTimeout(() => {
        entry.firstMessageTimer = null;
        if (entry.firstMessageSeen) return;
        entry.error = "Stream stalled: no data received";
        publish(entry);
        // Closing triggers onclose, which schedules a backed-off reconnect.
        ws.close();
      }, FIRST_MESSAGE_TIMEOUT_MS);
    }
    publish(entry);
    for (const sub of entry.subscribers) sub.getOptions()?.onConnect?.();
  };

  ws.onmessage = (event) => {
    if (!entry.firstMessageSeen) {
      entry.firstMessageSeen = true;
      entry.firstMessageTimer = clearTimer(entry.firstMessageTimer);
    }
    let msg: LogEntryMessage;
    try {
      msg = JSON.parse(event.data) as LogEntryMessage;
    } catch (err) {
      console.error("[json-patch-stream] Failed to process message:", err);
      entry.error = "Failed to process stream update";
      publish(entry);
      return;
    }

    if (msg.type === "json_patch") {
      entry.pendingOps.push(...msg.payload);
      if (entry.flushTimer === null) {
        // Batch via setTimeout(0): fires even when the window is backgrounded
        // (requestAnimationFrame is fully paused by Chromium/WebView when hidden).
        entry.flushTimer = setTimeout(() => flush(entry), 0);
      }
    } else if (msg.type === "finished") {
      entry.flushTimer = clearTimer(entry.flushTimer);
      flush(entry); // apply whatever remains (no-op if the buffer is empty)
      entry.finished = true;
      teardownSocket(entry);
      publish(entry);
      for (const sub of entry.subscribers) sub.getOptions()?.onFinished?.();
    } else {
      for (const sub of entry.subscribers) sub.getOptions()?.onMessage?.(msg);
    }
  };

  ws.onerror = () => {
    entry.error = "Connection failed";
    publish(entry);
    for (const sub of entry.subscribers)
      sub.getOptions()?.onError?.("Connection failed");
  };

  ws.onclose = (evt) => {
    if (entry.socket !== ws) return; // superseded by a newer socket; ignore
    entry.socket = null;
    entry.isConnected = false;
    entry.connectTimer = clearTimer(entry.connectTimer);
    entry.firstMessageTimer = clearTimer(entry.firstMessageTimer);
    publish(entry);
    if (entry.finished || (evt?.code === 1000 && evt?.wasClean)) return;
    if (entry.subscribers.size === 0) return; // nobody listening; let it rest
    entry.retryCount += 1;
    // An endpoint that has never connected is almost certainly a permanent
    // failure (handshake rejected: deleted/unknown id, refused). Stop after a
    // bounded number of attempts so it can't storm the server. A socket that
    // connected at least once keeps retrying forever (transient-drop recovery).
    if (!entry.everConnected && entry.retryCount > MAX_INITIAL_CONNECT_ATTEMPTS) {
      entry.error = "Unable to connect";
      publish(entry);
      return;
    }
    scheduleReconnect(entry);
  };
}

function scheduleReconnect(entry: StreamEntry): void {
  if (entry.retryTimer !== null) return;
  const delay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    1000 * 2 ** (entry.retryCount - 1),
  );
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (entry.subscribers.size === 0 || entry.finished) return;
    openSocket(entry);
  }, delay);
}

/** Close the live socket and clear all timers, leaving cached data intact. */
function teardownSocket(entry: StreamEntry): void {
  entry.flushTimer = clearTimer(entry.flushTimer);
  entry.firstMessageTimer = clearTimer(entry.firstMessageTimer);
  entry.connectTimer = clearTimer(entry.connectTimer);
  entry.retryTimer = clearTimer(entry.retryTimer);
  entry.pendingOps = [];
  const ws = entry.socket;
  entry.socket = null;
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close();
  }
  entry.isConnected = false;
}

function getOrCreate(
  endpoint: string,
  initialData: () => object,
  expectInitialMessage: boolean,
): StreamEntry {
  let entry = registry.get(endpoint);
  if (!entry) {
    entry = {
      endpoint,
      socket: null,
      document: initialData(),
      exposed: undefined,
      error: null,
      isConnected: false,
      finished: false,
      subscribers: new Set(),
      pendingOps: [],
      flushTimer: null,
      firstMessageTimer: null,
      connectTimer: null,
      firstMessageSeen: false,
      expectInitialMessage,
      everConnected: false,
      retryTimer: null,
      retryCount: 0,
      teardownTimer: null,
      snapshot: DISABLED_SNAPSHOT,
    };
    registry.set(endpoint, entry);
  }
  return entry;
}

/**
 * Register interest in `endpoint`. The first acquirer opens the socket; later
 * acquirers share it and immediately see the current snapshot. Returns a
 * release function (decrements the ref-count, tearing the socket down after a
 * short grace window once the last consumer leaves).
 */
export function acquireStream(
  endpoint: string,
  initialData: () => object,
  subscriber: StreamSubscriber,
  expectInitialMessage = true,
): () => void {
  const entry = getOrCreate(endpoint, initialData, expectInitialMessage);
  entry.teardownTimer = clearTimer(entry.teardownTimer);
  entry.subscribers.add(subscriber);
  // Open on first interest. A finished stream keeps its final data and is not
  // reopened; a reconnect already in flight (retryTimer set) is left alone.
  // Re-acquiring an idle entry (first mount, or a remount after the registry
  // gave up) starts from a clean backoff so it gets a fresh set of attempts.
  if (!entry.socket && !entry.finished && entry.retryTimer === null) {
    entry.retryCount = 0;
    entry.error = null;
    openSocket(entry);
  } else if (entry.isConnected) {
    subscriber.getOptions()?.onConnect?.();
  }
  return () => releaseStream(entry, subscriber);
}

function releaseStream(entry: StreamEntry, subscriber: StreamSubscriber): void {
  entry.subscribers.delete(subscriber);
  if (entry.subscribers.size > 0) return;
  entry.teardownTimer = clearTimer(entry.teardownTimer);
  entry.teardownTimer = setTimeout(() => {
    entry.teardownTimer = null;
    if (entry.subscribers.size > 0) return;
    teardownSocket(entry);
    registry.delete(entry.endpoint);
  }, TEARDOWN_GRACE_MS);
}

/** Current shared snapshot for `endpoint`, or the stable disabled snapshot. */
export function getStreamSnapshot<T>(
  endpoint: string,
): JsonPatchStreamSnapshot<T> {
  const entry = registry.get(endpoint);
  return (
    (entry?.snapshot as JsonPatchStreamSnapshot<T> | undefined) ??
    (DISABLED_SNAPSHOT as JsonPatchStreamSnapshot<T>)
  );
}

/**
 * Force the shared stream for `endpoint` to close now and stop reconnecting.
 * Affects every consumer of that endpoint. Rarely needed — the ref-counted
 * teardown handles the normal case.
 */
export function forceCloseStream(endpoint: string): void {
  const entry = registry.get(endpoint);
  if (!entry) return;
  entry.finished = true;
  teardownSocket(entry);
  publish(entry);
}

// Vite HMR: tear down live sockets so a hot reload of this module does not leak
// connections behind a freshly-created registry.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const entry of registry.values()) teardownSocket(entry);
    registry.clear();
  });
}
