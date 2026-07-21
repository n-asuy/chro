import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoEventsConfig } from "@/lib/repo-events";

const getWorkingDiffs = vi.fn();
const subscribeRepoEvents = vi.fn();
const disposeRepoEvents = vi.fn();

vi.mock("@/lib/git-client", () => ({
  getWorkingDiffs: (...args: unknown[]) => getWorkingDiffs(...args),
}));

vi.mock("@/lib/repo-events", () => ({
  repoEventsEndpoint: (scope: { taskRunId?: string; projectId?: string }) =>
    `endpoint:${scope.taskRunId ?? scope.projectId}`,
  subscribeRepoEvents: (
    endpoint: string,
    getConfig: () => RepoEventsConfig,
  ) => {
    subscribeRepoEvents(endpoint, getConfig);
    return disposeRepoEvents;
  },
}));

import { subscribeWorkingDiffs } from "./working-diffs-store";

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("working-diffs-store subscription", () => {
  beforeEach(() => {
    getWorkingDiffs.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches once on first subscribe and refetches on repo events (no timers)", async () => {
    vi.useFakeTimers();
    const unsubscribe = subscribeWorkingDiffs({ taskRunId: "run-1" });

    expect(getWorkingDiffs).toHaveBeenCalledTimes(1);
    expect(subscribeRepoEvents).toHaveBeenCalledWith(
      "endpoint:run-1",
      expect.any(Function),
    );

    // Time alone must not refetch: polling is gone.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getWorkingDiffs).toHaveBeenCalledTimes(1);

    // A repo event invalidation refetches.
    const getConfig = subscribeRepoEvents.mock.calls[0][1] as () => RepoEventsConfig;
    expect(getConfig().channels).toEqual(["files", "git"]);
    getConfig().onInvalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(getWorkingDiffs).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    unsubscribe();
    expect(disposeRepoEvents).toHaveBeenCalledTimes(1);
  });

  it("shares one subscription per scope key and disposes with the last consumer", async () => {
    const first = subscribeWorkingDiffs({ projectId: "p-1" });
    const second = subscribeWorkingDiffs({ projectId: "p-1" });
    await flushMicrotasks();

    expect(subscribeRepoEvents).toHaveBeenCalledTimes(1);

    first();
    expect(disposeRepoEvents).not.toHaveBeenCalled();
    second();
    expect(disposeRepoEvents).toHaveBeenCalledTimes(1);
  });
});
