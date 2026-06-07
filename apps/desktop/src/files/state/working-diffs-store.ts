/**
 * Shared working-tree diff cache, keyed by project.
 *
 * Both the source-control panel (for per-file +/- counts) and the
 * working-changes diff tab read from here. A single ref-counted poll loop per
 * project backs all subscribers, so opening the diff tab while the panel is
 * visible does not double the network traffic. Polling pauses while the
 * document is hidden, mirroring `use-git-status`.
 */
import { type WorkingDiffEntry, getWorkingDiffs } from "@/lib/git-client";
import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

const POLL_INTERVAL_MS = 3000;

export interface WorkingDiffsState {
  diffs: WorkingDiffEntry[];
  isLoading: boolean;
  error: string | null;
}

const EMPTY_STATE: WorkingDiffsState = {
  diffs: [],
  isLoading: false,
  error: null,
};

interface WorkingDiffsStore {
  byProject: Record<string, WorkingDiffsState>;
}

const useStore = create<WorkingDiffsStore>(() => ({ byProject: {} }));

// Subscription bookkeeping — intentionally outside reactive state.
const refCounts = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const inFlight = new Set<string>();

function patch(projectId: string, next: Partial<WorkingDiffsState>): void {
  useStore.setState((s) => ({
    byProject: {
      ...s.byProject,
      [projectId]: { ...(s.byProject[projectId] ?? EMPTY_STATE), ...next },
    },
  }));
}

async function fetchOnce(projectId: string): Promise<void> {
  if (inFlight.has(projectId)) return;
  inFlight.add(projectId);
  const hasData =
    (useStore.getState().byProject[projectId]?.diffs.length ?? 0) > 0;
  if (!hasData) patch(projectId, { isLoading: true });
  try {
    const diffs = await getWorkingDiffs(projectId);
    patch(projectId, { diffs, isLoading: false, error: null });
  } catch (err) {
    patch(projectId, {
      isLoading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlight.delete(projectId);
  }
}

/**
 * Force an immediate refresh — call after a git mutation (commit, discard) so
 * counts and the diff tab update without waiting for the next poll tick.
 */
export function refreshWorkingDiffs(projectId: string): Promise<void> {
  return fetchOnce(projectId);
}

function subscribeWorkingDiffs(projectId: string): () => void {
  const next = (refCounts.get(projectId) ?? 0) + 1;
  refCounts.set(projectId, next);
  if (next === 1) {
    void fetchOnce(projectId);
    const timer = setInterval(() => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      void fetchOnce(projectId);
    }, POLL_INTERVAL_MS);
    timers.set(projectId, timer);
  }
  return () => {
    const count = (refCounts.get(projectId) ?? 1) - 1;
    if (count <= 0) {
      refCounts.delete(projectId);
      const timer = timers.get(projectId);
      if (timer) clearInterval(timer);
      timers.delete(projectId);
    } else {
      refCounts.set(projectId, count);
    }
  };
}

/**
 * Subscribe to the shared working-tree diffs for a project. Returns the cached
 * slice and keeps the project's poll loop alive while mounted.
 */
export function useWorkingDiffs(
  projectId: string | null | undefined,
): WorkingDiffsState {
  useEffect(() => {
    if (!projectId) return;
    return subscribeWorkingDiffs(projectId);
  }, [projectId]);

  return useStore(
    useShallow((s) =>
      projectId ? s.byProject[projectId] ?? EMPTY_STATE : EMPTY_STATE,
    ),
  );
}
