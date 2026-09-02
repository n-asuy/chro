/**
 * Local, dev-only event sink for the renderer.
 *
 * Buffers activity and flushes it to the backend's dev-events endpoint, which
 * appends it to a JSONL file on this machine. Nothing recorded here is ever
 * transmitted to PostHog: `capture()` in `analytics.ts` owns that path and
 * gates it on a separate egress allowlist.
 *
 * Enabled in dev builds, and in any build made with `CHRO_DEV_EVENTS=1`.
 */

import { getBackendBaseUrl } from "./backend-client";

const INGEST_PATH = "/rpc/dev-events";
const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_AT_EVENTS = 50;

/** Hard cap so a runaway emitter cannot grow the buffer without bound. */
const MAX_BUFFER = 2_000;

export type DevEventProps = Record<string, unknown>;

interface BufferedEvent {
  event: string;
  ts: string;
  props: DevEventProps;
}

/** Identifies one page load, so events can be grouped by app run. */
const session = createSessionId();

const buffer: BufferedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let dropped = 0;

function createSessionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `session-${Math.random().toString(36).slice(2)}`;
}

export function isDevEventsEnabled(): boolean {
  return import.meta.env.DEV || __DEV_EVENTS_FORCED__;
}

export function devEventsSessionId(): string {
  return session;
}

/**
 * Record one event. Cheap and synchronous: it appends to a buffer that is
 * flushed on a timer, so instrumentation never sits in front of a user action.
 */
export function recordDevEvent(event: string, props?: DevEventProps): void {
  if (!isDevEventsEnabled()) return;

  buffer.push({
    event,
    ts: new Date().toISOString(),
    props: props ?? {},
  });

  if (buffer.length > MAX_BUFFER) {
    // Drop the oldest: recent activity is what a developer is looking at.
    dropped += buffer.length - MAX_BUFFER;
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }

  if (buffer.length >= FLUSH_AT_EVENTS) {
    void flushDevEvents();
  }
}

function ingestUrl(): string {
  return `${getBackendBaseUrl().replace(/\/$/, "")}${INGEST_PATH}`;
}

/**
 * Send everything buffered. Failures drop the batch rather than retrying: a
 * local recording tool must never queue up work or spam the console when the
 * backend is restarting.
 */
export async function flushDevEvents(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;

  const batch = buffer.splice(0, buffer.length);
  if (dropped > 0) {
    batch.push({
      event: "dev_events.dropped",
      ts: new Date().toISOString(),
      props: { count: dropped },
    });
    dropped = 0;
  }

  try {
    await fetch(ingestUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, events: batch }),
    });
  } catch {
    // Backend unavailable; the batch is gone on purpose.
  } finally {
    flushing = false;
  }
}

/**
 * Flush without waiting for a response, for page teardown where a pending
 * fetch would be cancelled.
 */
export function flushDevEventsOnUnload(): void {
  if (buffer.length === 0) return;

  const batch = buffer.splice(0, buffer.length);
  const body = JSON.stringify({ session, events: batch });

  if (
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function"
  ) {
    navigator.sendBeacon(
      ingestUrl(),
      new Blob([body], { type: "application/json" }),
    );
    return;
  }

  void fetch(ingestUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

/** Start periodic flushing. Returns a disposer. */
export function startDevEventFlushing(): () => void {
  if (!isDevEventsEnabled() || flushTimer !== null) {
    return () => {};
  }

  flushTimer = setInterval(() => {
    void flushDevEvents();
  }, FLUSH_INTERVAL_MS);

  const onPageHide = () => flushDevEventsOnUnload();
  window.addEventListener("pagehide", onPageHide);

  return () => {
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    window.removeEventListener("pagehide", onPageHide);
  };
}

/** Test seam: drop buffered state between cases. */
export function resetDevEventsForTest(): void {
  buffer.length = 0;
  dropped = 0;
  flushing = false;
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/** Test seam: inspect what would be sent. */
export function pendingDevEventsForTest(): readonly BufferedEvent[] {
  return buffer;
}
