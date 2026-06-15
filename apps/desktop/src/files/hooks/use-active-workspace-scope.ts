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
  /**
   * True while a focused session's run scope is still being resolved: its
   * task-runs stream is (re)connecting, so `runs` is transiently empty and
   * `taskRunId` reads as null even though the session will resolve to a
   * worktree run. The stream reconnects on every session switch, so consumers
   * must hold their last scope during this window instead of committing to the
   * project root — otherwise the full project tree flashes mid-switch.
   */
  isResolving: boolean;
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
  const { runs, isLoading: runsLoading } = useTaskRunsStream({
    taskId: sessionTaskId,
    enabled: Boolean(sessionTaskId),
  });

  // A concrete session tab scopes to one of its runs, but the run id is only
  // known once the runs stream delivers its first snapshot. Until then — most
  // notably the WebSocket reconnect that fires on every session switch — the
  // scope reads as null. Flag that window so the file tree holds its last
  // scope rather than falling back to (and flashing) the project root. Gated on
  // the resolved `sessionTaskId` (not the route key) so the stream is actually
  // enabled and loading: this keeps the window bounded by the stream's
  // first-message watchdog and never strands the tree if the key is unmappable.
  const isResolving = Boolean(sessionTaskId) && runsLoading;

  return {
    taskRunId: resolveScopeTaskRunId(focusedKind, runs, workspacePath),
    isResolving,
  };
}
