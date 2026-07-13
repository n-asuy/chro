import type { TranslationFunction } from "@/i18n";
import { desktopFetch } from "@/lib/backend-client";
import type { ExecutorProfileId } from "@/lib/executor-client";
import { recordPerfEvent, startPerfTimer } from "@/perf/recorder";
import { useCallback } from "react";
import type { PromptEditorHandle } from "../state/prompt-editor-store";
import type { StartClaudeResponse } from "../types";
import type { ContextRefPayload } from "../types/context";
import {
  type AbortControllerRegistry,
  isAbortError,
} from "../utils/abort-controller-registry";
import { cancelTaskRun, sendTaskMessage } from "../utils/task-message-api";

type MutableRef<T> = {
  current: T;
};

export type PreparedPromptPayload = {
  prompt: string;
  contextRefs: ContextRefPayload[];
  imageIds: string[] | null;
  selectedSkillIds: string[];
};

type UseSingleSessionControllerArgs = {
  workspace: string | null;
  routeProjectId: string | null;
  activeTaskId: string | null;
  taskRunId: string | null;
  forceNewAttempt: boolean;
  useWorktree: boolean;
  baseBranch: string | null;
  sessionExecutorSelection: ExecutorProfileId | null;
  executorProfileId: ExecutorProfileId | null;
  t: TranslationFunction;
  editor: PromptEditorHandle;
  isSessionMountedRef: MutableRef<boolean>;
  latestRouteProjectIdRef: MutableRef<string | null>;
  /** The task slug of the currently open session route, null on the new-session view. */
  latestRouteTaskSlugRef: MutableRef<string | null>;
  abortRegistry: AbortControllerRegistry;
  addErrorMessage: (message: string) => void;
  navigateToSession: (taskId?: string | null, runId?: string | null) => void;
  createPerfRequestId: () => string;
};

export function useSingleSessionController({
  workspace,
  routeProjectId,
  activeTaskId,
  taskRunId,
  forceNewAttempt,
  useWorktree,
  baseBranch,
  sessionExecutorSelection,
  executorProfileId,
  t,
  editor,
  isSessionMountedRef,
  latestRouteProjectIdRef,
  latestRouteTaskSlugRef,
  abortRegistry,
  addErrorMessage,
  navigateToSession,
  createPerfRequestId,
}: UseSingleSessionControllerArgs) {
  const submitPrompt = useCallback(
    async (
      payload: PreparedPromptPayload,
      options?: {
        requestId?: string;
        restoreOnError?: boolean;
        onAccepted?: (response: StartClaudeResponse) => void;
        // Force a specific task-message mode regardless of the session's
        // `forceNewAttempt` toggle. A malformed-tool-call retry, for instance,
        // must always continue the existing session ("auto"), never start over.
        mode?: "auto" | "new";
      },
    ): Promise<boolean> => {
      const hasTaskContext = Boolean(activeTaskId);
      if (!workspace && !hasTaskContext) {
        addErrorMessage(t("workspaceNotSetError"));
        return false;
      }

      const taskMessageMode =
        options?.mode ?? (forceNewAttempt ? "new" : "auto");
      const requestProjectId = routeProjectId;
      const requestTaskSlug = latestRouteTaskSlugRef.current;
      const requestId = options?.requestId ?? createPerfRequestId();
      // Track the request so teardown (unmount, project switch) can abort the
      // in-flight POST, and so a Stop pressed before its run exists (the
      // create window) can mark the run for cancellation once it does. The
      // server runs creation detached from this request, so an abort only
      // discards the response; the run itself always reaches a real state.
      const abortController = abortRegistry.create(requestId);
      const finishSendTimer = startPerfTimer("session_send", {
        request_id: requestId,
        task_id: activeTaskId ?? null,
        task_run_id: taskRunId ?? null,
        task_message_mode: hasTaskContext ? taskMessageMode : "create",
        prompt_chars: payload.prompt.length,
        image_count: payload.imageIds?.length ?? 0,
        skill_count: payload.selectedSkillIds.length,
        use_worktree: useWorktree,
      });

      try {
        const executorProfilePayload =
          sessionExecutorSelection ?? executorProfileId;

        const response = activeTaskId
          ? await sendTaskMessage(activeTaskId, {
              prompt: payload.prompt,
              mode: taskMessageMode,
              requestId,
              executorProfileId: executorProfilePayload,
              imageIds: payload.imageIds,
              contextRefs: payload.contextRefs,
              selectedSkillIds: payload.selectedSkillIds,
              useWorktree,
              targetBranch: baseBranch,
              signal: abortController.signal,
            })
          : await desktopFetch<StartClaudeResponse>("/rpc/executions/claude", {
              method: "POST",
              signal: abortController.signal,
              headers: {
                "Content-Type": "application/json",
                "x-perf-request-id": requestId,
              },
              body: JSON.stringify({
                prompt: payload.prompt,
                workspace_path: workspace,
                force_new_attempt: forceNewAttempt,
                task_id: undefined,
                use_worktree: useWorktree,
                executor_profile_id: executorProfilePayload ?? undefined,
                image_ids: payload.imageIds ?? undefined,
                context_refs: payload.contextRefs,
                selected_skill_ids: payload.selectedSkillIds,
                target_branch: baseBranch ?? undefined,
              }),
            });

        if (abortRegistry.consumeCancelRequest(requestId)) {
          // Stop was pressed while the run was still being created. Creation
          // is atomic on the server, so cancel the run it produced instead of
          // pretending it never existed.
          void cancelTaskRun(response.task_run_id).catch(() => {
            // Best-effort: the stream reflects the true status regardless.
          });
          finishSendTimer({
            outcome: "cancelled_after_create",
            response_task_id: response.task_id,
            response_task_run_id: response.task_run_id,
          });
          return false;
        }

        if (
          !isSessionMountedRef.current ||
          latestRouteProjectIdRef.current !== requestProjectId
        ) {
          finishSendTimer({
            outcome: "discarded",
            reason: "project_changed",
            response_task_id: response.task_id,
            response_task_run_id: response.task_run_id,
          });
          return false;
        }

        recordPerfEvent("session_task_run_started", {
          request_id: requestId,
          task_id: response.task_id,
          task_run_id: response.task_run_id,
        });

        options?.onAccepted?.(response);
        // Only pull the view to the created session if the user is still where
        // they sent from; opening another session mid-create must not be
        // hijacked back. The accepted run still lands in the sidebar stream.
        const stayedOnSendView =
          latestRouteTaskSlugRef.current === requestTaskSlug;
        if (stayedOnSendView) {
          navigateToSession(response.task_slug ?? response.task_id, null);
        }
        finishSendTimer({
          outcome: "ok",
          navigated: stayedOnSendView,
          response_task_id: response.task_id,
          response_task_run_id: response.task_run_id,
        });
        return true;
      } catch (error) {
        if (isAbortError(error)) {
          // Teardown (unmount, project switch, reset) aborted the request.
          // Not an error: no toast, and the caller drops the optimistic row.
          // The server finishes creating the run regardless, so the session
          // surfaces through the task stream when the user comes back.
          finishSendTimer({ outcome: "aborted" });
          return false;
        }
        console.error("[submitPrompt] Failed to start Claude execution", error);
        finishSendTimer({
          outcome: "error",
          error:
            error instanceof Error
              ? error.message
              : "unknown_handle_send_error",
        });
        const fallback =
          error instanceof Error
            ? error.message
            : t("commandFailedError", { message: t("claudeCliHint") });
        addErrorMessage(fallback);
        if (options?.restoreOnError) {
          editor.restore();
        }
        return false;
      } finally {
        abortRegistry.release(requestId);
      }
    },
    [
      workspace,
      addErrorMessage,
      t,
      taskRunId,
      forceNewAttempt,
      routeProjectId,
      createPerfRequestId,
      activeTaskId,
      useWorktree,
      sessionExecutorSelection,
      executorProfileId,
      baseBranch,
      isSessionMountedRef,
      latestRouteProjectIdRef,
      latestRouteTaskSlugRef,
      abortRegistry,
      navigateToSession,
      editor,
    ],
  );

  return {
    submitPrompt,
  };
}
