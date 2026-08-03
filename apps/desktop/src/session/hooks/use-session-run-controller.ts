import { useCallback, useState } from "react";
import {
  type SessionRunState,
  deriveSessionRunState,
  resolveCancelAction,
} from "../domain/session-run-state";
import type { PendingSessionSubmission } from "../domain/session-task-state";
import type { TaskRunRecord } from "../types/api";
import { cancelTaskRun } from "../utils/task-message-api";

type UseSessionRunControllerArgs = {
  /** Runs for the active task from the task-runs WebSocket stream. */
  taskRuns: TaskRunRecord[];
  /** True until the task-runs stream has delivered its first snapshot. */
  isTaskRunsLoading: boolean;
  /** The active optimistic submission for this scope, or null. */
  pendingSubmission: PendingSessionSubmission | null;
  /** The task's `active_session_id`, used only as a stream-loading hint. */
  activeSessionHint: string | null | undefined;
  /** Run whose conversation log stream has not emitted `finished` yet. */
  streamingRunId?: string | null;
  /**
   * Mark an in-flight create request so the run it produces is cancelled as
   * soon as the create response returns its id. Creation is atomic on the
   * server, so it cannot be torn down mid-flight; this is how Stop lands
   * during the create window.
   */
  requestCancelSubmission: (requestId: string) => void;
  /** Drop an optimistic submission by its request id. */
  clearPendingSubmission: (requestId?: string) => void;
};

export type UseSessionRunControllerResult = SessionRunState & {
  /** Alias of `isRunning`; whether to show Stop instead of Send. */
  isSending: boolean;
  /** A cancel RPC is in flight. */
  isStopping: boolean;
  /** Stop the active run, or mark the in-flight create for cancellation. */
  handleCancel: () => Promise<void>;
};

/**
 * Owns session run state and cancellation, derived from the task-runs stream
 * plus an established live log socket until its `finished` marker. Replaces
 * the previous imperative
 * `activeTaskRunIdRef` whose cancel target went stale or null right after a
 * send, so Stop did nothing during the window the user most wanted it.
 */
export function useSessionRunController({
  taskRuns,
  isTaskRunsLoading,
  pendingSubmission,
  activeSessionHint,
  streamingRunId,
  requestCancelSubmission,
  clearPendingSubmission,
}: UseSessionRunControllerArgs): UseSessionRunControllerResult {
  const [isStopping, setIsStopping] = useState(false);

  const runState = deriveSessionRunState({
    taskRuns,
    isTaskRunsLoading,
    pendingSubmission,
    activeSessionHint,
    streamingRunId,
  });
  const { cancelTargetRunId, isInCreateWindow } = runState;

  const handleCancel = useCallback(async () => {
    const action = resolveCancelAction(
      { cancelTargetRunId, isInCreateWindow },
      pendingSubmission,
      isStopping,
    );

    if (action.type === "cancel-run") {
      setIsStopping(true);
      try {
        await cancelTaskRun(action.runId);
      } catch {
        // Best-effort: the stream reflects the true status regardless.
      } finally {
        setIsStopping(false);
      }
      return;
    }

    if (action.type === "cancel-create" && action.requestId) {
      requestCancelSubmission(action.requestId);
      clearPendingSubmission(action.requestId);
    }
  }, [
    cancelTargetRunId,
    isInCreateWindow,
    pendingSubmission,
    isStopping,
    requestCancelSubmission,
    clearPendingSubmission,
  ]);

  return {
    ...runState,
    isSending: runState.isRunning,
    isStopping,
    handleCancel,
  };
}
