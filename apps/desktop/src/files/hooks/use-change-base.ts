import { useDiffStream } from "@/session/hooks/use-diff-stream";
import { useMemo } from "react";
import { type ChangeBase, resolveChangeBase } from "../lib/change-base";
import { useWorkingDiffs } from "../state/working-diffs-store";

/**
 * The base version of an open file, from the same diff its scope's diff tab
 * shows: the session's changes for a worktree file, uncommitted changes for a
 * project file. Files outside both (extra workspace roots) have none.
 */
export function useChangeBase({
  projectId,
  taskRunId,
  relativePath,
  enabled,
}: {
  projectId: string | null;
  taskRunId: string | null;
  relativePath: string | null;
  enabled: boolean;
}): ChangeBase {
  const runDiffs = useDiffStream({
    taskRunId,
    enabled: enabled && Boolean(taskRunId),
  });
  const working = useWorkingDiffs(
    enabled && !taskRunId && projectId ? { projectId } : null,
  );

  const runEntries = useMemo(
    () =>
      Object.entries(runDiffs.diffs).map(([path, diff]) => ({ path, diff })),
    [runDiffs.diffs],
  );

  return useMemo(() => {
    if (!enabled || relativePath === null) return { kind: "unavailable" };
    if (taskRunId) {
      return resolveChangeBase({
        path: relativePath,
        diffs: runEntries,
        isLoading: runDiffs.isLoading,
      });
    }
    if (!projectId) return { kind: "unavailable" };
    return resolveChangeBase({
      path: relativePath,
      diffs: working.diffs,
      isLoading: working.isLoading,
    });
  }, [
    enabled,
    relativePath,
    taskRunId,
    projectId,
    runEntries,
    runDiffs.isLoading,
    working.diffs,
    working.isLoading,
  ]);
}
