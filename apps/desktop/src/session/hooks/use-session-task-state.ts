import { useCallback, useMemo, useState } from "react";
import {
  applyPendingSubmissionToTasks,
  createPendingSessionSubmission,
  resolveActiveTaskId,
  resolvePendingSessionSubmission,
  resolveStreamTaskId,
  type PendingSessionSubmission,
} from "../domain/session-task-state";
import type { StartClaudeResponse } from "../types/api";
import type { StoredTask } from "../types";

type UseSessionTaskStateParams = {
  projectId: string | null;
  routeTaskSlug: string | null;
  streamedTasks: StoredTask[];
};

type BeginPendingSessionSubmissionInput = {
  requestId: string;
  prompt: string;
  createdAt: string;
  taskId: string | null;
  taskSlug: string | null;
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
  clearPendingSubmission: (requestId?: string) => void;
};

export function useSessionTaskState({
  projectId,
  routeTaskSlug,
  streamedTasks,
}: UseSessionTaskStateParams): UseSessionTaskStateResult {
  const [pendingSubmission, setPendingSubmission] =
    useState<PendingSessionSubmission | null>(null);

  const streamedTasksById = useMemo(
    () =>
      Object.fromEntries(
        streamedTasks.map((task) => [task.id, task]),
      ) as Record<string, StoredTask>,
    [streamedTasks],
  );

  const tasks = useMemo(
    () => applyPendingSubmissionToTasks(streamedTasks, pendingSubmission, projectId),
    [projectId, pendingSubmission, streamedTasks],
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

  const activeStreamTaskId = useMemo(
    () => resolveStreamTaskId(activeTaskId, streamedTasksById, pendingSubmission),
    [activeTaskId, pendingSubmission, streamedTasksById],
  );

  const activeTask = useMemo(
    () => (activeTaskId ? tasksById[activeTaskId] ?? null : null),
    [activeTaskId, tasksById],
  );

  const beginPendingSubmission = useCallback(
    (
      input: BeginPendingSessionSubmissionInput,
    ): PendingSessionSubmission => {
      const next = createPendingSessionSubmission(input);
      setPendingSubmission(next);
      return next;
    },
    [],
  );

  const resolvePendingSubmissionWithResponse = useCallback(
    (requestId: string, response: StartClaudeResponse) => {
      setPendingSubmission((current) => {
        if (!current || current.requestId !== requestId) {
          return current;
        }
        return resolvePendingSessionSubmission(current, response);
      });
    },
    [],
  );

  const clearPendingSubmission = useCallback((requestId?: string) => {
    setPendingSubmission((current) => {
      if (!current) {
        return null;
      }
      if (requestId && current.requestId !== requestId) {
        return current;
      }
      return null;
    });
  }, []);

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
    clearPendingSubmission,
  };
}
