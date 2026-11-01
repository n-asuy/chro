import { desktopFetch } from "@/lib/backend-client";
import type { ExecutorProfileId } from "@/lib/executor-client";
import type { StartClaudeResponse } from "../types";
import type { ContextRefPayload } from "../types/context";

type TaskMessageMode = "auto" | "new";

type SendTaskMessageOptions = {
  prompt: string;
  mode: TaskMessageMode;
  requestId?: string;
  executorProfileId?: ExecutorProfileId | null;
  imageIds?: string[] | null;
  contextRefs?: ContextRefPayload[];
  selectedSkillIds?: string[];
  useWorktree?: boolean;
  targetBranch?: string | null;
  signal?: AbortSignal;
};

export async function cancelTaskRun(runId: string): Promise<void> {
  await desktopFetch(`/rpc/task-runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
}

const queueItemPath = (taskId: string, itemId: string) =>
  `/rpc/tasks/${encodeURIComponent(taskId)}/queue/${encodeURIComponent(itemId)}`;

/** Take a queued message back before it becomes a turn. */
export async function withdrawQueuedMessage(
  taskId: string,
  itemId: string,
): Promise<void> {
  await desktopFetch(queueItemPath(taskId, itemId), { method: "DELETE" });
}

/** Replace a queued message's text; its place and attachments stay. */
export async function editQueuedMessage(
  taskId: string,
  itemId: string,
  prompt: string,
): Promise<void> {
  await desktopFetch(queueItemPath(taskId, itemId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

/** Put the session's queue in this order. Fails (409) if the queue changed
 * since it was read. */
export async function reorderSessionQueue(
  taskId: string,
  itemIds: string[],
): Promise<void> {
  await desktopFetch(`/rpc/tasks/${encodeURIComponent(taskId)}/queue`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_ids: itemIds }),
  });
}

/** Stop the running turn and start this queued message instead. */
export async function sendQueuedMessageNow(
  taskId: string,
  itemId: string,
): Promise<{ started: boolean }> {
  return desktopFetch<{ started: boolean }>(
    `${queueItemPath(taskId, itemId)}/send`,
    { method: "POST" },
  );
}

function taskMessageRequest(options: SendTaskMessageOptions): RequestInit {
  return {
    method: "POST",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      ...(options.requestId
        ? { "x-perf-request-id": options.requestId }
        : undefined),
    },
    body: JSON.stringify({
      prompt: options.prompt,
      mode: options.mode,
      executor_profile_id: options.executorProfileId ?? undefined,
      image_ids: options.imageIds ?? undefined,
      context_refs: options.contextRefs ?? [],
      selected_skill_ids: options.selectedSkillIds ?? [],
      use_worktree: options.useWorktree,
      target_branch: options.targetBranch ?? undefined,
    }),
  };
}

export async function sendTaskMessage(
  taskId: string,
  options: SendTaskMessageOptions,
): Promise<StartClaudeResponse> {
  return desktopFetch<StartClaudeResponse>(
    `/rpc/tasks/${encodeURIComponent(taskId)}/messages`,
    taskMessageRequest(options),
  );
}

export type QueueTaskMessageResponse = {
  /** False when the turn had ended and the message started one at once. */
  queued: boolean;
  position: number | null;
};

/** Put a message behind the session's running turn; it keeps its images,
 * context and skills until it becomes the next turn. */
export async function queueTaskMessage(
  taskId: string,
  options: SendTaskMessageOptions,
): Promise<QueueTaskMessageResponse> {
  return desktopFetch<QueueTaskMessageResponse>(
    `/rpc/tasks/${encodeURIComponent(taskId)}/queue`,
    taskMessageRequest(options),
  );
}
