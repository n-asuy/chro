/**
 * Keeps feature flags fresh in a long-lived window.
 *
 * Flags are resolved once at startup, which is fine until a flag is flipped
 * remotely: a desktop window can stay open for days, so a kill switch would
 * never reach it. This re-resolves them on a slow interval, and immediately
 * when the window comes back to the foreground (the cheap case that matters
 * most: the flag was flipped while the machine was asleep).
 *
 * Hidden windows are skipped rather than polled, matching how the rest of the
 * app polls (see `use-branch-status`).
 */

export const FLAG_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

interface StartFlagRefreshOptions {
  /** Re-resolve the registry. Must be safe to call concurrently. */
  refresh: () => void;
  intervalMs?: number;
  /** Injected for tests; defaults to the real timers/document. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  visibility?: {
    isVisible: () => boolean;
    subscribe: (listener: () => void) => () => void;
  };
}

const documentVisibility = () => ({
  isVisible: () => document.visibilityState === "visible",
  subscribe: (listener: () => void) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
});

/** Returns a stop function; call it to cancel the timer and listener. */
export function startFlagRefresh({
  refresh,
  intervalMs = FLAG_REFRESH_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  visibility = documentVisibility(),
}: StartFlagRefreshOptions): () => void {
  const refreshIfVisible = () => {
    if (visibility.isVisible()) refresh();
  };

  const timer = setIntervalFn(refreshIfVisible, intervalMs);
  const unsubscribe = visibility.subscribe(refreshIfVisible);

  return () => {
    clearIntervalFn(timer);
    unsubscribe();
  };
}
