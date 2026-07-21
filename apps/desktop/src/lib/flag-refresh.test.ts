import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAG_REFRESH_INTERVAL_MS, startFlagRefresh } from "./flag-refresh";

function fakeVisibility(initial = true) {
  let visible = initial;
  const listeners = new Set<() => void>();
  return {
    isVisible: () => visible,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
    set(next: boolean) {
      visible = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("startFlagRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not refresh before the first interval elapses", () => {
    const refresh = vi.fn();
    startFlagRefresh({ refresh, visibility: fakeVisibility() });

    vi.advanceTimersByTime(FLAG_REFRESH_INTERVAL_MS - 1);

    // Startup already resolved the flags; re-resolving right away would just
    // double the request for no new information.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes once per interval while visible", () => {
    const refresh = vi.fn();
    startFlagRefresh({ refresh, visibility: fakeVisibility() });

    vi.advanceTimersByTime(FLAG_REFRESH_INTERVAL_MS * 3);

    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("skips the tick while the window is hidden", () => {
    const visibility = fakeVisibility(false);
    const refresh = vi.fn();
    startFlagRefresh({ refresh, visibility });

    vi.advanceTimersByTime(FLAG_REFRESH_INTERVAL_MS * 2);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes as soon as the window becomes visible again", () => {
    const visibility = fakeVisibility(false);
    const refresh = vi.fn();
    startFlagRefresh({ refresh, visibility });

    visibility.set(true);

    // The common case: the flag was flipped while the machine was asleep, so
    // waiting out the rest of the hour would show stale state to a user who is
    // looking right at it.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the window becomes hidden", () => {
    const visibility = fakeVisibility(true);
    const refresh = vi.fn();
    startFlagRefresh({ refresh, visibility });

    visibility.set(false);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops the timer and unsubscribes once stopped", () => {
    const visibility = fakeVisibility();
    const refresh = vi.fn();

    const stop = startFlagRefresh({ refresh, visibility });
    stop();
    vi.advanceTimersByTime(FLAG_REFRESH_INTERVAL_MS * 5);
    visibility.set(true);

    expect(refresh).not.toHaveBeenCalled();
    expect(visibility.listenerCount()).toBe(0);
  });

  it("defaults to an hourly interval", () => {
    expect(FLAG_REFRESH_INTERVAL_MS).toBe(3_600_000);
  });
});
