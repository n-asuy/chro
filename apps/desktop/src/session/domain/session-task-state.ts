import type { StartClaudeResponse } from "../types/api";
import type { StoredTask } from "../types";

export const OPTIMISTIC_TASK_PREFIX = "optimistic-task-";
export const OPTIMISTIC_RUN_PREFIX = "optimistic-run-";
const MAX_PENDING_TASK_TITLE_CHARS = 80;

export type PendingSessionSubmission = {
  requestId: string;
  prompt: string;
  createdAt: string;
  taskId: string | null;
  taskSlug: string | null;
  tempTaskId: string | null;
  runId: string | null;
  tempRunId: string;
};

const normalizeText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export function createPendingSessionSubmission(input: {
  requestId: string;
  prompt: string;
  createdAt: string;
  taskId: string | null;
  taskSlug: string | null;
}): PendingSessionSubmission {
  return {
    requestId: input.requestId,
    prompt: input.prompt,
    createdAt: input.createdAt,
    taskId: input.taskId,
    taskSlug: input.taskSlug,
    tempTaskId: input.taskId ? null : `${OPTIMISTIC_TASK_PREFIX}${input.requestId}`,
    runId: null,
    tempRunId: `${OPTIMISTIC_RUN_PREFIX}${input.requestId}`,
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

  return `${firstLine
    .slice(0, MAX_PENDING_TASK_TITLE_CHARS - 3)
    .trimEnd()}...`;
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

  byId.set(taskId, {
    id: taskId,
    slug: pending.taskSlug,
    project_id: projectId ?? current?.project_id ?? "",
    title: current?.title?.trim() ? current.title : title,
    description: current?.description ?? null,
    status: current?.status ?? "in_progress",
    branch: current?.branch ?? null,
    active_session_id:
      current?.active_session_id ?? pending.runId ?? pending.tempRunId,
    created_at: current?.created_at ?? pending.createdAt,
    updated_at:
      current &&
      new Date(current.updated_at).getTime() >
        new Date(pending.createdAt).getTime()
        ? current.updated_at
        : pending.createdAt,
    sort_order: current?.sort_order ?? -1,
  });

  if (pending.tempTaskId && pending.taskId) {
    byId.delete(pending.tempTaskId);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return (
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  });
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
