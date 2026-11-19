import { desktopFetch } from "@/lib/backend-client";
import { fetchExecutorProfile } from "@/lib/executor-client";
import type { ImageResponse } from "@/lib/image-client";
import { selectTargetTaskRun } from "@/session/domain/task-run-selection";
import { parseExecutorProfileId } from "@/session/lib/executor-profile";
import type { StartClaudeResponse, TaskRunRecord } from "@/session/types";
import {
  queueTaskMessage,
  sendTaskMessage,
} from "@/session/utils/task-message-api";
import { taskApi } from "@/tasks/task-api";
import type { TalkTarget } from "../domain/talk";

/**
 * Sends a voice message or a capture from the edge toolbar through chro's
 * own send paths: a follow-up to a session the way the edge composer sends
 * one (into the session when it is idle, its queue while a turn runs, with
 * the agent of its last run), or a new chat the way the main window's "New
 * chat" starts one (the hidden General project, the default agent).
 */

/** An image already uploaded to chro (a capture). */
export type UploadedImage = Pick<
  ImageResponse,
  "id" | "file_path" | "original_name"
>;

/** A message: what was said or typed, and the screenshot it is about. */
export interface EdgeMessage {
  text: string;
  image?: UploadedImage | null;
}

/** The prompt with an attached image, laid out as the composer lays it out. */
export function promptWithImage(
  text: string,
  image: UploadedImage | null,
): string {
  const markdown = image ? `![${image.original_name}](${image.file_path})` : "";
  return [markdown, text.trim()].filter(Boolean).join("\n");
}

/** Send `message` to `target`; resolves with the task it went to. */
export async function sendEdgeMessage(
  target: TalkTarget,
  message: EdgeMessage,
): Promise<{ taskId: string }> {
  const image = message.image ?? null;
  const prompt = promptWithImage(message.text, image);
  const imageIds = image ? [image.id] : null;

  if (target.kind === "session") {
    const { runs } = await desktopFetch<{ runs: TaskRunRecord[] }>(
      `/rpc/tasks/${encodeURIComponent(target.taskId)}/runs`,
    );
    const run = selectTargetTaskRun(runs);
    const options = {
      prompt,
      mode: "auto" as const,
      executorProfileId: parseExecutorProfileId(run?.executor_label),
      imageIds,
    };
    if (runs.some((r) => r.status === "running")) {
      await queueTaskMessage(target.taskId, options);
    } else {
      await sendTaskMessage(target.taskId, options);
    }
    return { taskId: target.taskId };
  }

  const [general, profile] = await Promise.all([
    taskApi.ensureGeneralProject(),
    fetchExecutorProfile(),
  ]);
  const response = await desktopFetch<StartClaudeResponse>(
    "/rpc/executions/claude",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        workspace_path: general.gitRepoPath,
        force_new_attempt: false,
        // Chats have no repository, so no worktree (as the main window
        // decides for a project that is not a git repository).
        use_worktree: false,
        executor_profile_id: profile.profile ?? undefined,
        image_ids: imageIds ?? undefined,
        context_refs: [],
        selected_skill_ids: [],
      }),
    },
  );
  return { taskId: response.task_id };
}
