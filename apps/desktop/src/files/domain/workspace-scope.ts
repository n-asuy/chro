import { resolveUseWorktreeForRun } from "@/session/domain/execution-mode";
import { selectTargetTaskRun } from "@/session/domain/task-run-selection";
import type { TaskRunRecord } from "@/session/types";
import type { TabKind } from "@/workspace-layout/types";

/**
 * Decide which task run's worktree (session sandbox) the file tree should
 * display for the given focused tab. Returns null to fall back to the
 * project's main checkout.
 *
 * - file tab → its `taskRunId` (a worktree file opened from a session);
 * - diff tab → its `runId`;
 * - session tab → the session's active run, unless that run is "local" (it
 *   executes on the project checkout itself), in which case null;
 * - new session / project file / terminal / settings / no tab → null.
 */
export const resolveScopeTaskRunId = (
  focusedKind: TabKind | null,
  runs: TaskRunRecord[],
  workspacePath: string | null,
): string | null => {
  if (!focusedKind) return null;
  switch (focusedKind.type) {
    case "file":
      return focusedKind.taskRunId ?? null;
    case "diff":
      return focusedKind.runId;
    case "session": {
      if (!focusedKind.taskId) return null;
      const run = selectTargetTaskRun(runs, focusedKind.runId ?? undefined);
      if (!run) return null;
      // Local runs work directly on the project checkout — show the project
      // root so its tree (and edits) behave normally.
      if (!resolveUseWorktreeForRun(run, workspacePath)) return null;
      return run.id;
    }
    default:
      return null;
  }
};
