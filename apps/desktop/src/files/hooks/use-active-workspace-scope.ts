import { useProjectContext } from "@/files/context/project-context";
import { resolveScopeTaskRunId } from "@/files/domain/workspace-scope";
import { useOptionalProjectTasks } from "@/session/context/project-tasks-context";
import { useTaskRunsStream } from "@/session/hooks/use-task-runs-stream";
import { findFocusedTab } from "@/workspace-layout/hooks/use-route-tab-sync";
import { useLayoutStore } from "@/workspace-layout/state/layout-store";
import type { TabKind } from "@/workspace-layout/types";
import { useShallow } from "zustand/react/shallow";

export interface ActiveWorkspaceScope {
  /**
   * Task run whose worktree (session sandbox) the file tree should display, or
   * null to fall back to the project's main checkout. Resolved from the
   * focused center tab — see {@link resolveScopeTaskRunId}.
   */
  taskRunId: string | null;
}

/**
 * Resolve which workspace the right-dock file tree should reflect. Driven by
 * the focused tab's resource scope so browsing a session shows its sandbox,
 * while new sessions, local runs, and project-level surfaces show the project
 * root.
 */
export function useActiveWorkspaceScope(): ActiveWorkspaceScope {
  const { workspacePath } = useProjectContext();
  const projectTasks = useOptionalProjectTasks();

  // Track only the focused tab's kind; useShallow keeps the value stable
  // (same field references) until the focused tab actually changes.
  const focusedKind = useLayoutStore(
    useShallow((s): TabKind | null => findFocusedTab(s.layout)?.kind ?? null),
  );

  // A session tab's `taskId` is a route key (slug or UUID). The runs stream
  // filters by `run.task_id`, which is always the UUID, so resolve the key to
  // the task's id first — otherwise the stream returns no runs and the scope
  // silently falls back to the project root.
  const sessionTaskKey =
    focusedKind?.type === "session" ? focusedKind.taskId ?? null : null;
  const sessionTaskId = sessionTaskKey
    ? projectTasks?.taskByKey.get(sessionTaskKey)?.id ?? null
    : null;

  // Streamed unconditionally (enabled-gated) to satisfy the rules of hooks;
  // only consumed when the focused tab is a concrete session.
  const { runs } = useTaskRunsStream({
    taskId: sessionTaskId,
    enabled: Boolean(sessionTaskId),
  });

  return { taskRunId: resolveScopeTaskRunId(focusedKind, runs, workspacePath) };
}
