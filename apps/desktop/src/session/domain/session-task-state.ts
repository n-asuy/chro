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
  /**
   * Task ids already present in the project's task stream when this submission
   * was made. A new-task submission has no server task id until its HTTP
   * response returns, yet the task stream broadcasts the created task as soon as
   * the backend inserts it — well before that response (worktree + agent spawn
   * happen first). Snapshotting the pre-submission ids lets the optimistic row
   * adopt the freshly-streamed task the instant it appears, so the sidebar never
   * shows the optimistic and real rows side by side.
   */
  knownTaskIds: string[];
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
  knownTaskIds?: string[];
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
    knownTaskIds: input.knownTaskIds ?? [],
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

/**
 * For an unresolved new-task submission, find the streamed task it created: one
 * that was absent when the submission was made (`knownTaskIds`) and not already
 * claimed by an earlier pending in the same pass. Picks the most recently
 * created candidate so the newest arrival wins when several are unknown.
 */
function findAdoptableStreamTask(
  streamedTasks: StoredTask[],
  pending: PendingSessionSubmission,
  claimed: Set<string>,
): StoredTask | null {
  const known = new Set(pending.knownTaskIds);
  let adopted: StoredTask | null = null;
  for (const task of streamedTasks) {
    if (known.has(task.id) || claimed.has(task.id)) {
      continue;
    }
    if (
      !adopted ||
      new Date(task.created_at).getTime() >
        new Date(adopted.created_at).getTime()
    ) {
      adopted = task;
    }
  }
  return adopted;
}

export function applyPendingSubmissionToTasks(
  streamedTasks: StoredTask[],
  pending: PendingSessionSubmission | null,
  projectId: string | null,
  claimed: Set<string> = new Set(),
): StoredTask[] {
  if (!pending) {
    return streamedTasks;
  }

  // A follow-up overlays its existing task. A new-task submission renders an
  // optimistic row keyed by `tempTaskId` until either the server response
  // resolves a real `taskId`, or the task stream delivers the created task —
  // whichever lands first. Adopting the streamed task collapses the optimistic
  // and real rows into one the moment the stream catches up, instead of waiting
  // for the (slower) HTTP response.
  let targetId = pending.taskId ?? pending.tempTaskId;
  if (!pending.taskId && pending.tempTaskId && !pending.finishedAt) {
    const adopted = findAdoptableStreamTask(streamedTasks, pending, claimed);
    if (adopted) {
      targetId = adopted.id;
    }
  }
  if (!targetId) {
    return streamedTasks;
  }
  claimed.add(targetId);

  const title = derivePendingTaskTitle(pending.prompt);
  const byId = new Map(streamedTasks.map((task) => [task.id, task]));
  const current = byId.get(targetId);
  const isFinished = Boolean(pending.finishedAt);
  const pendingActiveSessionId = isFinished
    ? null
    : pending.runId ?? pending.tempRunId;
  const pendingUpdatedAt = pending.finishedAt ?? pending.createdAt;

  byId.set(targetId, {
    id: targetId,
    slug: current?.slug ?? pending.taskSlug,
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
  const claimed = new Set<string>();
  return pendingSubmissions
    .slice()
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    .reduce(
      (tasks, pending) =>
        applyPendingSubmissionToTasks(tasks, pending, projectId, claimed),
      streamedTasks,
    );
}

/**
 * Overlay optimistic rows from several projects onto one cross-project task
 * list. Each group's submissions are applied only against their own project's
 * slice of the list, so a new-task submission can only adopt a freshly-streamed
 * task from the same project — never another project's task or optimistic row
 * (the single-project `applyPendingSubmissionToTasks` adopts any unknown task,
 * which is safe only when the stream is already project-scoped). The result
 * order is unspecified; callers that care must sort.
 */
export function applyPendingSubmissionGroupsToTasks(
  streamedTasks: StoredTask[],
  groups: readonly {
    projectId: string | null;
    submissions: PendingSessionSubmission[];
  }[],
): StoredTask[] {
  if (groups.length === 0) return streamedTasks;

  const byProject = new Map<string, StoredTask[]>();
  for (const task of streamedTasks) {
    const slice = byProject.get(task.project_id);
    if (slice) slice.push(task);
    else byProject.set(task.project_id, [task]);
  }

  const result: StoredTask[] = [];
  const applied = new Set<string>();
  for (const group of groups) {
    const key = group.projectId ?? "";
    applied.add(key);
    result.push(
      ...applyPendingSubmissionsToTasks(
        byProject.get(key) ?? [],
        group.submissions,
        group.projectId,
      ),
    );
  }
  for (const [key, tasks] of byProject) {
    if (!applied.has(key)) result.push(...tasks);
  }
  return result;
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
