/**
 * Shared working-tree diff cache, keyed by scope (project checkout or a task
 * run's worktree).
 *
 * Both the source-control panel (for per-file +/- counts) and the
 * working-changes diff tab read from here. A single ref-counted repo-events
 * subscription per scope backs all subscribers, so opening the diff tab while
 * the panel is visible does not double the network traffic. Refreshes are
 * driven by worktree/git change events instead of an interval.
 */
import {
  type GitScope,
  type WorkingDiffEntry,
  getWorkingDiffs,
} from "@/lib/git-client";
import { repoEventsEndpoint, subscribeRepoEvents } from "@/lib/repo-events";
import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

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
  byScope: Record<string, WorkingDiffsState>;
}

const useStore = create<WorkingDiffsStore>(() => ({ byScope: {} }));

const scopeKey = (scope: GitScope, base?: string): string => {
  const root =
    "taskRunId" in scope
      ? `run:${scope.taskRunId}`
      : `project:${scope.projectId}`;
  return base ? `${root}@${base}` : root;
};

// Subscription bookkeeping — intentionally outside reactive state.
const refCounts = new Map<string, number>();
const disposers = new Map<string, () => void>();
const inFlight = new Set<string>();

function patch(key: string, next: Partial<WorkingDiffsState>): void {
  useStore.setState((s) => ({
    byScope: {
      ...s.byScope,
      [key]: { ...(s.byScope[key] ?? EMPTY_STATE), ...next },
    },
  }));
}

async function fetchOnce(scope: GitScope, base?: string): Promise<void> {
  const key = scopeKey(scope, base);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const hasData = (useStore.getState().byScope[key]?.diffs.length ?? 0) > 0;
  if (!hasData) patch(key, { isLoading: true });
  try {
    const diffs = await getWorkingDiffs(scope, base);
    patch(key, { diffs, isLoading: false, error: null });
  } catch (err) {
    patch(key, {
      isLoading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlight.delete(key);
  }
}

export function subscribeWorkingDiffs(scope: GitScope, base?: string): () => void {
  const key = scopeKey(scope, base);
  const next = (refCounts.get(key) ?? 0) + 1;
  refCounts.set(key, next);
  if (next === 1) {
    void fetchOnce(scope, base);
    // Working diffs change with the working tree, the index (staging), and
    // HEAD (commits fold working changes into the base comparison).
    const dispose = subscribeRepoEvents(repoEventsEndpoint(scope), () => ({
      channels: ["files", "git"],
      onInvalidate: () => void fetchOnce(scope, base),
    }));
    disposers.set(key, dispose);
  }
  return () => {
    const count = (refCounts.get(key) ?? 1) - 1;
    if (count <= 0) {
      refCounts.delete(key);
      disposers.get(key)?.();
      disposers.delete(key);
    } else {
      refCounts.set(key, count);
    }
  };
}

/**
 * Subscribe to the shared working-tree diffs for a scope (project or run).
 * With `base`, diffs against that branch ref (all branch changes) instead of
 * HEAD. Returns the cached slice and keeps the poll loop alive while mounted.
 */
export function useWorkingDiffs(
  scope: GitScope | null | undefined,
  base?: string,
): WorkingDiffsState {
  const key = scope ? scopeKey(scope, base) : null;
  useEffect(() => {
    if (!scope) return;
    return subscribeWorkingDiffs(scope, base);
    // Re-subscribe only when the resolved scope key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return useStore(
    useShallow((s) => (key ? s.byScope[key] ?? EMPTY_STATE : EMPTY_STATE)),
  );
}
