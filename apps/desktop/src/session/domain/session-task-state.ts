import type { StoredTask } from "../types";
import type { StartClaudeResponse } from "../types/api";

export const OPTIMISTIC_TASK_PREFIX = "optimistic-task-";
export const OPTIMISTIC_RUN_PREFIX = "optimistic-run-";
const MAX_PENDING_TASK_TITLE_CHARS = 80;

export type PendingSessionSubmission = {
  scopeId: string;
  requestId: string;
  prompt: string;
  createdAt: string;
  taskId: string | null;
  taskSlug: string | null;
  tempTaskId: string | null;
  runId: string | null;
  tempRunId: string;
  startedWithoutTask: boolean;
  finishedAt: string | null;
};

const normalizeText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export function createPendingSessionSubmission(input: {
  scopeId: string;
  requestId: string;
  prompt: string;
  createdAt: string;
  taskId: string | null;
  taskSlug: string | null;
}): PendingSessionSubmission {
  return {
    scopeId: input.scopeId,
    requestId: input.requestId,
    prompt: input.prompt,
    createdAt: input.createdAt,
    taskId: input.taskId,
    taskSlug: input.taskSlug,
    tempTaskId: input.taskId
      ? null
      : `${OPTIMISTIC_TASK_PREFIX}${input.requestId}`,
    runId: null,
    tempRunId: `${OPTIMISTIC_RUN_PREFIX}${input.requestId}`,
    startedWithoutTask: !input.taskId,
    finishedAt: null,
  };
}

export function resolvePendingSessionSubmission(
  pending: PendingSessionSubmission,
  response: StartClaudeResponse,
): PendingSessionSubmission {
  return {
    ...pending,
    taskId: response.task_id,
    taskSlug: response.task_slug ?? pending.taskSlug,
    tempTaskId: null,
    runId: response.task_run_id,
  };
}

export function finishPendingSessionSubmission(
  pending: PendingSessionSubmission,
  finishedAt: string,
): PendingSessionSubmission {
  return {
    ...pending,
    finishedAt,
  };
}

export function derivePendingTaskTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .find(Boolean);

  if (!firstLine) {
    return "";
  }

  if (firstLine.length <= MAX_PENDING_TASK_TITLE_CHARS) {
    return firstLine;
  }

  return `${firstLine.slice(0, MAX_PENDING_TASK_TITLE_CHARS - 3).trimEnd()}...`;
}

export function applyPendingSubmissionToTasks(
  streamedTasks: StoredTask[],
  pending: PendingSessionSubmission | null,
  projectId: string | null,
): StoredTask[] {
  if (!pending) {
    return streamedTasks;
  }

  const taskId = pending.taskId ?? pending.tempTaskId;
  if (!taskId) {
    return streamedTasks;
  }

  const title = derivePendingTaskTitle(pending.prompt);
  const byId = new Map(streamedTasks.map((task) => [task.id, task]));
  const current = byId.get(taskId);
  const isFinished = Boolean(pending.finishedAt);
  const pendingActiveSessionId = isFinished
    ? null
    : pending.runId ?? pending.tempRunId;
  const pendingUpdatedAt = pending.finishedAt ?? pending.createdAt;

  byId.set(taskId, {
    id: taskId,
    slug: pending.taskSlug,
    project_id: projectId ?? current?.project_id ?? "",
    title: current?.title?.trim() ? current.title : title,
    description: current?.description ?? null,
    status: current?.status ?? (isFinished ? "completed" : "in_progress"),
    branch: current?.branch ?? null,
    active_session_id: current?.active_session_id ?? pendingActiveSessionId,
    created_at: current?.created_at ?? pending.createdAt,
    updated_at:
      current &&
      new Date(current.updated_at).getTime() >
        new Date(pendingUpdatedAt).getTime()
        ? current.updated_at
        : pendingUpdatedAt,
    sort_order: current?.sort_order ?? -1,
  });

  if (pending.tempTaskId && pending.taskId) {
    byId.delete(pending.tempTaskId);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
}

export function applyPendingSubmissionsToTasks(
  streamedTasks: StoredTask[],
  pendingSubmissions: PendingSessionSubmission[],
  projectId: string | null,
): StoredTask[] {
  return pendingSubmissions
    .slice()
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    .reduce(
      (tasks, pending) =>
        applyPendingSubmissionToTasks(tasks, pending, projectId),
      streamedTasks,
    );
}

export function resolveActiveTaskId(
  routeTaskSlug: string | null,
  displayedTasks: StoredTask[],
): string | null {
  if (!routeTaskSlug) return null;
  const matchedTask = displayedTasks.find(
    (task) => task.id === routeTaskSlug || task.slug === routeTaskSlug,
  );
  return matchedTask?.id ?? null;
}

export function resolveStreamTaskId(
  activeTaskId: string | null,
  streamedTasksById: Record<string, StoredTask>,
  pending: PendingSessionSubmission | null,
): string | null {
  if (!activeTaskId) {
    return null;
  }

  if (streamedTasksById[activeTaskId]) {
    return activeTaskId;
  }

  if (pending?.taskId === activeTaskId) {
    return pending.taskId;
  }

  return null;
}

export function isPendingSubmissionForTaskScope(
  pending: PendingSessionSubmission | null,
  activeTaskId: string | null,
  streamTaskId: string | null,
  sessionScopeId?: string | null,
): pending is PendingSessionSubmission {
  if (!pending) {
    return false;
  }

  const isSameSessionScope =
    !sessionScopeId || pending.scopeId === sessionScopeId;

  if (!activeTaskId && !streamTaskId && pending.startedWithoutTask) {
    return isSameSessionScope;
  }

  if (pending.taskId) {
    return pending.taskId === activeTaskId || pending.taskId === streamTaskId;
  }

  if (pending.tempTaskId && pending.tempTaskId === activeTaskId) {
    return isSameSessionScope;
  }

  return !activeTaskId && !streamTaskId && isSameSessionScope;
}

export function isPendingSubmissionSettledByTask(
  pending: PendingSessionSubmission | null,
  task: StoredTask | null | undefined,
): boolean {
  if (!pending?.taskId || !pending.runId || !task) {
    return false;
  }

  if (task.id !== pending.taskId || task.active_session_id) {
    return false;
  }

  const taskUpdatedAt = new Date(task.updated_at).getTime();
  const pendingCreatedAt = new Date(pending.createdAt).getTime();
  if (Number.isNaN(taskUpdatedAt) || Number.isNaN(pendingCreatedAt)) {
    return false;
  }

  return taskUpdatedAt > pendingCreatedAt;
}
