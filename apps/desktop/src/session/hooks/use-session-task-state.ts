import { useCallback, useMemo } from "react";
import {
  type PendingSessionSubmission,
  applyPendingSubmissionsToTasks,
  isPendingSubmissionForTaskScope,
  resolveActiveTaskId,
  resolveStreamTaskId,
} from "../domain/session-task-state";
import {
  type BeginPendingSessionSubmissionInput,
  usePendingSessionSubmissions,
  usePendingSessionSubmissionsStore,
} from "../state/pending-session-submissions-store";
import type { StoredTask } from "../types";
import type { StartClaudeResponse } from "../types/api";

type UseSessionTaskStateParams = {
  scopeId: string;
  projectId: string | null;
  routeTaskSlug: string | null;
  streamedTasks: StoredTask[];
};

export type UseSessionTaskStateResult = {
  tasks: StoredTask[];
  tasksById: Record<string, StoredTask>;
  streamedTasksById: Record<string, StoredTask>;
  activeTaskId: string | null;
  activeStreamTaskId: string | null;
  activeTask: StoredTask | null;
  pendingSubmission: PendingSessionSubmission | null;
  beginPendingSubmission: (
    input: BeginPendingSessionSubmissionInput,
  ) => PendingSessionSubmission;
  resolvePendingSubmission: (
    requestId: string,
    response: StartClaudeResponse,
  ) => void;
  finishPendingSubmission: (requestId: string, finishedAt: string) => void;
  clearPendingSubmission: (requestId?: string) => void;
};

export function useSessionTaskState({
  scopeId,
  projectId,
  routeTaskSlug,
  streamedTasks,
}: UseSessionTaskStateParams): UseSessionTaskStateResult {
  const streamedTasksById = useMemo(
    () =>
      Object.fromEntries(
        streamedTasks.map((task) => [task.id, task]),
      ) as Record<string, StoredTask>,
    [streamedTasks],
  );
  const pendingSubmissions = usePendingSessionSubmissions(
    projectId,
    streamedTasksById,
  );
  const scopedPendingSubmissions = useMemo(
    () => pendingSubmissions.filter((pending) => pending.scopeId === scopeId),
    [pendingSubmissions, scopeId],
  );
  const beginStorePendingSubmission = usePendingSessionSubmissionsStore(
    (state) => state.beginPendingSubmission,
  );
  const resolveStorePendingSubmission = usePendingSessionSubmissionsStore(
    (state) => state.resolvePendingSubmission,
  );
  const finishStorePendingSubmission = usePendingSessionSubmissionsStore(
    (state) => state.finishPendingSubmission,
  );
  const clearStorePendingSubmission = usePendingSessionSubmissionsStore(
    (state) => state.clearPendingSubmission,
  );

  const tasks = useMemo(
    () =>
      applyPendingSubmissionsToTasks(
        streamedTasks,
        scopedPendingSubmissions,
        projectId,
      ),
    [projectId, scopedPendingSubmissions, streamedTasks],
  );

  const tasksById = useMemo(
    () =>
      Object.fromEntries(tasks.map((task) => [task.id, task])) as Record<
        string,
        StoredTask
      >,
    [tasks],
  );

  const activeTaskId = useMemo(
    () => resolveActiveTaskId(routeTaskSlug, tasks),
    [routeTaskSlug, tasks],
  );

  const pendingSubmissionForActiveTask = useMemo(
    () =>
      scopedPendingSubmissions.find((pending) =>
        isPendingSubmissionForTaskScope(
          pending,
          activeTaskId,
          activeTaskId,
          scopeId,
        ),
      ) ?? null,
    [activeTaskId, scopedPendingSubmissions, scopeId],
  );

  const activeStreamTaskId = useMemo(
    () =>
      resolveStreamTaskId(
        activeTaskId,
        streamedTasksById,
        pendingSubmissionForActiveTask,
      ),
    [activeTaskId, pendingSubmissionForActiveTask, streamedTasksById],
  );

  const pendingSubmission = useMemo(
    () =>
      scopedPendingSubmissions.find((pending) =>
        isPendingSubmissionForTaskScope(
          pending,
          activeTaskId,
          activeStreamTaskId,
          scopeId,
        ),
      ) ?? null,
    [activeStreamTaskId, activeTaskId, scopedPendingSubmissions, scopeId],
  );

  const activeTask = useMemo(
    () => (activeTaskId ? tasksById[activeTaskId] ?? null : null),
    [activeTaskId, tasksById],
  );

  const beginPendingSubmission = useCallback(
    (input: BeginPendingSessionSubmissionInput): PendingSessionSubmission => {
      return beginStorePendingSubmission(projectId, { ...input, scopeId });
    },
    [beginStorePendingSubmission, projectId, scopeId],
  );

  const resolvePendingSubmissionWithResponse = useCallback(
    (requestId: string, response: StartClaudeResponse) => {
      resolveStorePendingSubmission(projectId, requestId, response);
    },
    [projectId, resolveStorePendingSubmission],
  );

  const clearPendingSubmission = useCallback(
    (requestId?: string) => {
      clearStorePendingSubmission(projectId, requestId);
    },
    [clearStorePendingSubmission, projectId],
  );

  const finishPendingSubmission = useCallback(
    (requestId: string, finishedAt: string) => {
      finishStorePendingSubmission(projectId, requestId, finishedAt);
    },
    [finishStorePendingSubmission, projectId],
  );

  return {
    tasks,
    tasksById,
    streamedTasksById,
    activeTaskId,
    activeStreamTaskId,
    activeTask,
    pendingSubmission,
    beginPendingSubmission,
    resolvePendingSubmission: resolvePendingSubmissionWithResponse,
    finishPendingSubmission,
    clearPendingSubmission,
  };
}
