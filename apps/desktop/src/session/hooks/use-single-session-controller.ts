import type { TranslationFunction } from "@/i18n";
import { desktopFetch } from "@/lib/backend-client";
import type { ExecutorProfileId } from "@/lib/executor-client";
import { recordPerfEvent, startPerfTimer } from "@/perf/recorder";
import { useCallback } from "react";
import { resolveUseWorktreeForRun } from "../domain/execution-mode";
import {
  selectTargetTaskRun,
  toTaskAttemptFromRun,
} from "../domain/task-run-selection";
import type { PromptEditorHandle } from "../state/prompt-editor-store";
import type { StartClaudeResponse, TaskAttempt, TaskRunRecord } from "../types";
import { sendTaskMessage } from "../utils/task-message-api";

type MutableRef<T> = {
  current: T;
};

type SetState<T> = (value: T | ((prev: T) => T)) => void;

export type PreparedPromptPayload = {
  prompt: string;
  imageIds: string[] | null;
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
  taskRunLoadTokenRef: MutableRef<number>;
  parseExecutorProfileId: (
    value: string | null | undefined,
  ) => ExecutorProfileId | null;
  setCurrentTaskRunTargetBranch: SetState<string | null>;
  setCurrentContainerRef: SetState<string | null>;
  setUseWorktree: SetState<boolean>;
  setSessionExecutorProfile: SetState<ExecutorProfileId | null>;
  setCurrentAttempt: SetState<TaskAttempt | null>;
  setOptimisticSending: SetState<boolean>;
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
  taskRunLoadTokenRef,
  parseExecutorProfileId,
  setCurrentTaskRunTargetBranch,
  setCurrentContainerRef,
  setUseWorktree,
  setSessionExecutorProfile,
  setCurrentAttempt,
  setOptimisticSending,
  setIsStopping,
  addErrorMessage,
  navigateToSession,
  createPerfRequestId,
}: UseSingleSessionControllerArgs) {
  const loadTaskRunData = useCallback(
    async (
      taskId: string,
      selectedRunId?: string,
      options?: {
        requestId?: string;
        loadToken?: number;
      },
    ): Promise<TaskRunRecord | null> => {
      let loadToken = options?.loadToken;
      if (loadToken === undefined) {
        taskRunLoadTokenRef.current += 1;
        loadToken = taskRunLoadTokenRef.current;
      }

      const response = await desktopFetch<{ runs: TaskRunRecord[] }>(
        `/rpc/tasks/${taskId}/runs`,
        options?.requestId
          ? {
              headers: {
                "x-perf-request-id": options.requestId,
              },
            }
          : undefined,
      );

      if (loadToken !== taskRunLoadTokenRef.current) {
        return null;
      }

      const runs = response.runs ?? [];
      const targetRun = selectTargetTaskRun(runs, selectedRunId);
      if (!targetRun) {
        return null;
      }

      if (loadToken !== taskRunLoadTokenRef.current) {
        return null;
      }

      setCurrentTaskRunTargetBranch(targetRun.target_branch ?? null);
      const runExecutionPath =
        targetRun.container_ref ?? targetRun.workspace_path;
      setCurrentContainerRef(runExecutionPath ?? null);
      setUseWorktree(resolveUseWorktreeForRun(targetRun, workspace));

      const runExecutorProfile =
        parseExecutorProfileId(targetRun.executor_label) ??
        executorProfileId ??
        null;
      setSessionExecutorProfile(runExecutorProfile);

      activeTaskRunIdRef.current = targetRun.id;
      setCurrentAttempt(toTaskAttemptFromRun(taskId, targetRun));

      return targetRun;
    },
    [
      taskRunLoadTokenRef,
      setCurrentTaskRunTargetBranch,
      setCurrentContainerRef,
      setUseWorktree,
      workspace,
      parseExecutorProfileId,
      executorProfileId,
      setSessionExecutorProfile,
      activeTaskRunIdRef,
      setCurrentAttempt,
    ],
  );

  const submitPrompt = useCallback(
    async (
      payload: PreparedPromptPayload,
      options?: {
        restoreOnError?: boolean;
      },
    ): Promise<boolean> => {
      const hasTaskContext = Boolean(activeTaskId);
      if (!workspace && !hasTaskContext) {
        addErrorMessage(t("workspaceNotSetError"));
        return false;
      }

      const taskMessageMode = forceNewAttempt ? "new" : "auto";
      const requestProjectId = routeProjectId;
      const requestId = createPerfRequestId();
      const finishSendTimer = startPerfTimer("session_send", {
        request_id: requestId,
        task_id: activeTaskId ?? null,
        task_run_id: taskRunId ?? null,
        task_message_mode: hasTaskContext ? taskMessageMode : "create",
        prompt_chars: payload.prompt.length,
        image_count: payload.imageIds?.length ?? 0,
        use_worktree: useWorktree,
      });

      setOptimisticSending(true);
      try {
        const executorProfilePayload =
          sessionExecutorSelection ?? executorProfileId;
        if (activeTaskId) {
          // Let the server resolve reuse-vs-new for task-bound sends and
          // invalidate any in-flight run lookup that was based on older state.
          taskRunLoadTokenRef.current += 1;
        }

        const response = activeTaskId
          ? await sendTaskMessage(activeTaskId, {
              prompt: payload.prompt,
              mode: taskMessageMode,
              requestId,
              executorProfileId: executorProfilePayload,
              imageIds: payload.imageIds,
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
            setOptimisticSending(false);
          }
          return false;
        }

        activeTaskRunIdRef.current = response.task_run_id;
        recordPerfEvent("session_task_run_started", {
          request_id: requestId,
          task_id: response.task_id,
          task_run_id: response.task_run_id,
        });

        setCurrentAttempt({
          id: response.task_run_id,
          task_id: response.task_id,
          status: "running",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        navigateToSession(response.task_id, null);
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
        setOptimisticSending(false);
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
      taskRunLoadTokenRef,
      isSessionMountedRef,
      latestRouteProjectIdRef,
      setOptimisticSending,
      activeTaskRunIdRef,
      setCurrentAttempt,
      navigateToSession,
      editor,
    ],
  );

  const handleCancel = useCallback(async () => {
    if (!isSending || isStopping) return;
    const targetRunId = activeTaskRunIdRef.current ?? taskRunId;
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
      setOptimisticSending(false);
    }
  }, [
    isSending,
    isStopping,
    activeTaskRunIdRef,
    taskRunId,
    setIsStopping,
    setOptimisticSending,
  ]);

  return {
    loadTaskRunData,
    submitPrompt,
    handleCancel,
  };
}
