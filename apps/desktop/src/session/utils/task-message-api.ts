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

export async function sendTaskMessage(
  taskId: string,
  options: SendTaskMessageOptions,
): Promise<StartClaudeResponse> {
  return desktopFetch<StartClaudeResponse>(
    `/rpc/tasks/${encodeURIComponent(taskId)}/messages`,
    {
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
    },
  );
}
