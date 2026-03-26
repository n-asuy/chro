import type { AnyRouter } from "@tanstack/react-router";

const FLUSH_INTERVAL_MS = 30_000;
const MEMORY_SAMPLE_INTERVAL_MS = 10_000;
const MAX_BUFFER = 5_000;

interface PerfEntry {
  ts: string;
  type: string;
  [key: string]: unknown;
}

const buffer: PerfEntry[] = [];
let flushing = false;
let recordingEnabled = false;

// Baseline timestamp set at recording start — entries older than this are stale.
let recordingBaselineAt = 0;

// --- Disposable lifecycle ---

type CleanupFn = () => void;
const disposables: CleanupFn[] = [];

function registerDisposable(fn: CleanupFn): void {
  disposables.push(fn);
}

function disposeAll(): void {
  for (const fn of disposables) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
  disposables.length = 0;
}

// --- Helpers ---

function now(): string {
  return new Date().toISOString();
}

function push(entry: PerfEntry): void {
  buffer.push(entry);
}

function roundDurationMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function isStale(entry: PerformanceEntry): boolean {
  return entry.startTime < recordingBaselineAt;
}

function safeObserve(
  type: string,
  callback: PerformanceObserverCallback,
  options?: { buffered?: boolean },
): void {
  try {
    const observer = new PerformanceObserver(callback);
    observer.observe({ type, buffered: options?.buffered ?? false });
    registerDisposable(() => observer.disconnect());
  } catch {
    // Observer type not supported
  }
}

// --- Public API ---

export function recordPerfEvent(
  name: string,
  fields?: Record<string, unknown>,
): void {
  if (!recordingEnabled) return;
  push({
    ts: now(),
    type: "ui-action",
    name,
    ...fields,
  });
}

export function startPerfTimer(
  name: string,
  fields?: Record<string, unknown>,
): (result?: Record<string, unknown>) => void {
  const startedAt = performance.now();
  recordPerfEvent(`${name}_start`, fields);
  return (result?: Record<string, unknown>) => {
    recordPerfEvent(`${name}_end`, {
      ...fields,
      ...result,
      duration_ms: roundDurationMs(performance.now() - startedAt),
    });
  };
}

// --- Flush ---

async function sendEntries(
  entries: PerfEntry[],
  options?: { keepalive?: boolean },
) {
  const response = await fetch("/perf/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entries),
    keepalive: options?.keepalive,
  });

  if (!response.ok) {
    throw new Error(`perf report failed: ${response.status}`);
  }
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const entries = buffer.splice(0, buffer.length);
  try {
    await sendEntries(entries, { keepalive: true });
  } catch {
    if (buffer.length + entries.length <= MAX_BUFFER) {
      buffer.unshift(...entries);
    }
    // Over limit — drop the failed entries to prevent unbounded growth
  } finally {
    flushing = false;
  }
}

function flushOnPageExit(): void {
  if (flushing || buffer.length === 0) return;

  const entries = buffer.splice(0);
  const payload = JSON.stringify(entries);
  const body = new Blob([payload], { type: "application/json" });
  const sent = navigator.sendBeacon("/perf/report", body);
  if (!sent) {
    if (buffer.length + entries.length <= MAX_BUFFER) {
      buffer.unshift(...entries);
    }
    void flush();
  }
}

// --- Observers ---

function observeWebVitals(): void {
  // Largest Contentful Paint
  safeObserve(
    "largest-contentful-paint",
    (list) => {
      for (const entry of list.getEntries()) {
        if (isStale(entry)) continue;
        push({
          ts: now(),
          type: "web-vital",
          name: "LCP",
          value: Math.round(entry.startTime),
        });
      }
    },
    { buffered: true },
  );

  // First Contentful Paint
  safeObserve(
    "paint",
    (list) => {
      for (const entry of list.getEntries()) {
        if (isStale(entry)) continue;
        if (entry.name === "first-contentful-paint") {
          push({
            ts: now(),
            type: "web-vital",
            name: "FCP",
            value: Math.round(entry.startTime),
          });
        }
      }
    },
    { buffered: true },
  );

  // Layout Shift (CLS) with session windowing per web-vitals spec
  let clsSessionValue = 0;
  let clsSessionEntries: PerformanceEntry[] = [];
  let clsBestSessionValue = 0;

  safeObserve(
    "layout-shift",
    (list) => {
      for (const entry of list.getEntries()) {
        if (isStale(entry)) continue;
        const layoutShift = entry as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (layoutShift.hadRecentInput) continue;

        const lastEntry =
          clsSessionEntries[clsSessionEntries.length - 1];
        if (
          lastEntry &&
          (entry.startTime - lastEntry.startTime > 1000 ||
            entry.startTime - clsSessionEntries[0].startTime > 5000)
        ) {
          if (clsSessionValue > clsBestSessionValue) {
            clsBestSessionValue = clsSessionValue;
          }
          clsSessionValue = 0;
          clsSessionEntries = [];
        }

        clsSessionEntries.push(entry);
        clsSessionValue += layoutShift.value;

        push({
          ts: now(),
          type: "web-vital",
          name: "CLS",
          value:
            Math.round(
              Math.max(clsBestSessionValue, clsSessionValue) * 10000,
            ) / 10000,
        });
      }
    },
    { buffered: true },
  );

  // Interaction to Next Paint (INP) via event timing
  safeObserve(
    "event",
    (list) => {
      for (const entry of list.getEntries()) {
        if (isStale(entry)) continue;
        const eventEntry = entry as PerformanceEntry & {
          processingStart: number;
          processingEnd: number;
          duration: number;
          name: string;
        };
        if (eventEntry.duration > 100) {
          push({
            ts: now(),
            type: "web-vital",
            name: "INP-candidate",
            event: eventEntry.name,
            duration: Math.round(eventEntry.duration),
            processingTime: Math.round(
              eventEntry.processingEnd - eventEntry.processingStart,
            ),
          });
        }
      }
    },
    { buffered: true },
  );
}

function observeLongTasks(): void {
  safeObserve(
    "longtask",
    (list) => {
      for (const entry of list.getEntries()) {
        if (isStale(entry)) continue;
        push({
          ts: now(),
          type: "long-task",
          duration: Math.round(entry.duration),
          startTime: Math.round(entry.startTime),
        });
      }
    },
    { buffered: true },
  );
}

function observeResourceTiming(): void {
  safeObserve("resource", (list) => {
    for (const entry of list.getEntries()) {
      const resource = entry as PerformanceResourceTiming;
      if (resource.duration > 500) {
        push({
          ts: now(),
          type: "slow-resource",
          name: resource.name,
          duration: Math.round(resource.duration),
          transferSize: resource.transferSize,
          initiatorType: resource.initiatorType,
        });
      }
    }
  });
}

function sampleMemory(): void {
  const perf = performance as Performance & {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  };
  if (!perf.memory) return;

  const id = setInterval(() => {
    if (!perf.memory) return;
    push({
      ts: now(),
      type: "memory",
      usedJSHeapSize: perf.memory.usedJSHeapSize,
      totalJSHeapSize: perf.memory.totalJSHeapSize,
      jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
    });
  }, MEMORY_SAMPLE_INTERVAL_MS);
  registerDisposable(() => clearInterval(id));
}

// --- Route transition tracking ---

export function observeRouteTransitions(router: AnyRouter): void {
  if (!recordingEnabled) return;

  let currentPath = router.state.location.pathname;
  let navigationStartedAt: number | null = null;

  const unsubscribe = router.subscribe("onBeforeNavigate", () => {
    navigationStartedAt = performance.now();
  });
  registerDisposable(unsubscribe);

  const unsubscribeResolved = router.subscribe("onResolved", () => {
    const toPath = router.state.location.pathname;
    const durationMs =
      navigationStartedAt !== null
        ? roundDurationMs(performance.now() - navigationStartedAt)
        : null;

    push({
      ts: now(),
      type: "route-transition",
      from: currentPath,
      to: toPath,
      duration_ms: durationMs,
    });

    currentPath = toPath;
    navigationStartedAt = null;
  });
  registerDisposable(unsubscribeResolved);
}

// --- Recording lifecycle ---

export function startPerfRecording(): void {
  // Idempotent: tear down previous session before re-initializing
  disposeAll();

  recordingEnabled = true;
  recordingBaselineAt = performance.now();

  console.log(
    "[perf] Performance recording enabled — flushing to log/performance/",
  );
  recordPerfEvent("perf_recording_started");
  observeWebVitals();
  observeLongTasks();
  observeResourceTiming();
  sampleMemory();

  const flushId = setInterval(flush, FLUSH_INTERVAL_MS);
  registerDisposable(() => clearInterval(flushId));

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      flushOnPageExit();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  registerDisposable(() =>
    document.removeEventListener("visibilitychange", onVisibilityChange),
  );

  const onBeforeUnload = () => flushOnPageExit();
  window.addEventListener("beforeunload", onBeforeUnload);
  registerDisposable(() =>
    window.removeEventListener("beforeunload", onBeforeUnload),
  );
}

