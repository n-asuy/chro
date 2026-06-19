import type { TranslationFunction } from "@/i18n";
import { desktopFetch } from "@/lib/backend-client";
import type { ExecutorProfileId } from "@/lib/executor-client";
import { recordPerfEvent, startPerfTimer } from "@/perf/recorder";
import { useCallback } from "react";
import type { PromptEditorHandle } from "../state/prompt-editor-store";
import type { StartClaudeResponse } from "../types";
import type { ContextRefPayload } from "../types/context";
import { sendTaskMessage } from "../utils/task-message-api";

type MutableRef<T> = {
  current: T;
};

type SetState<T> = (value: T | ((prev: T) => T)) => void;

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
  isSending: boolean;
  isStopping: boolean;
  t: TranslationFunction;
  editor: PromptEditorHandle;
  isSessionMountedRef: MutableRef<boolean>;
  latestRouteProjectIdRef: MutableRef<string | null>;
  activeTaskRunIdRef: MutableRef<string | null>;
  setIsStopping: SetState<boolean>;
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
  isSending,
  isStopping,
  t,
  editor,
  isSessionMountedRef,
  latestRouteProjectIdRef,
  activeTaskRunIdRef,
  setIsStopping,
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
      const requestId = options?.requestId ?? createPerfRequestId();
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
            })
          : await desktopFetch<StartClaudeResponse>("/rpc/executions/claude", {
              method: "POST",
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
          if (isSessionMountedRef.current) {
            activeTaskRunIdRef.current = null;
          }
          return false;
        }

        activeTaskRunIdRef.current = response.task_run_id;
        recordPerfEvent("session_task_run_started", {
          request_id: requestId,
          task_id: response.task_id,
          task_run_id: response.task_run_id,
        });

        options?.onAccepted?.(response);
        navigateToSession(response.task_slug ?? response.task_id, null);
        finishSendTimer({
          outcome: "ok",
          response_task_id: response.task_id,
          response_task_run_id: response.task_run_id,
        });
        return true;
      } catch (error) {
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
      activeTaskRunIdRef,
      navigateToSession,
      editor,
    ],
  );

  const handleCancel = useCallback(async () => {
    if (!isSending || isStopping) return;
    const targetRunId = activeTaskRunIdRef.current ?? null;
    if (!targetRunId) return;

    try {
      setIsStopping(true);
      await desktopFetch(
        `/rpc/task-runs/${encodeURIComponent(targetRunId)}/cancel`,
        {
          method: "POST",
        },
      );
    } catch {
      // ignore
    } finally {
      setIsStopping(false);
    }
  }, [isSending, isStopping, activeTaskRunIdRef, taskRunId, setIsStopping]);

  return {
    submitPrompt,
    handleCancel,
  };
}
