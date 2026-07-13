import type { TaskRunRecord } from "../types/api";
import type { PendingSessionSubmission } from "./session-task-state";

/**
 * Run statuses that can still be cancelled. A run leaves this set the moment it
 * reaches a terminal status (completed/failed/cancelled) on the backend, which
 * the task-runs WebSocket stream reflects. This is the single definition of
 * "cancelable" shared by run-state derivation and the cancel target.
 */
export const CANCELABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "pending",
]);

export interface SessionRunStateInputs {
  /** Runs for the active task from the task-runs WebSocket stream. */
  taskRuns: TaskRunRecord[];
  /** True until the task-runs stream has delivered its first snapshot. */
  isTaskRunsLoading: boolean;
  /** The active optimistic submission for this scope, or null. */
  pendingSubmission: PendingSessionSubmission | null;
  /**
   * The task's `active_session_id`. Used ONLY as a transient "is running" hint
   * while the stream is still loading; once the stream has loaded it is ignored
   * so the stream stays the single source of truth.
   */
  activeSessionHint: string | null | undefined;
}

export interface SessionRunState {
  /** Whether a run is active right now (drives the Send vs Stop button). */
  isRunning: boolean;
  /**
   * A submission was sent but its real run has not appeared in the stream yet,
   * so no cancelable run id exists. Cancelling here records a cancel intent on
   * the in-flight create; the run is cancelled via RPC as soon as the create
   * response returns its id.
   */
  isInCreateWindow: boolean;
  /** The run id to cancel, taken from the stream. Null in the create window. */
  cancelTargetRunId: string | null;
}

/**
 * Single source of truth for session run state. Derives "is a run active" and
 * "which run to cancel" from the task-runs stream, with the optimistic
 * submission only covering the create window before the run reaches the stream.
 */
export function deriveSessionRunState({
  taskRuns,
  isTaskRunsLoading,
  pendingSubmission,
  activeSessionHint,
}: SessionRunStateInputs): SessionRunState {
  const cancelTargetRunId =
    taskRuns.find((run) => CANCELABLE_RUN_STATUSES.has(run.status))?.id ?? null;
  const streamHasActiveRun = cancelTargetRunId !== null;

  const streamShowsPendingRun = pendingSubmission?.runId
    ? taskRuns.some((run) => run.id === pendingSubmission.runId)
    : false;

  const isInCreateWindow =
    pendingSubmission !== null &&
    pendingSubmission.finishedAt === null &&
    !streamShowsPendingRun;

  // While the stream is still loading and there is no optimistic submission to
  // anchor on, fall back to the task's active_session_id so the button does not
  // flicker to "Send" mid-run. Once loaded, the stream alone decides.
  const isRunning =
    isTaskRunsLoading && pendingSubmission === null
      ? Boolean(activeSessionHint)
      : streamHasActiveRun || isInCreateWindow;

  return { isRunning, isInCreateWindow, cancelTargetRunId };
}

export type CancelAction =
  | { type: "none" }
  | { type: "cancel-run"; runId: string }
  | { type: "cancel-create"; requestId: string | null };

/**
 * Decide what cancelling should do, given the derived run state. A real run is
 * cancelled via its id; otherwise the in-flight create is marked for
 * cancellation once its run exists. Anything else (already finished, or
 * already stopping) is a no-op.
 */
export function resolveCancelAction(
  state: Pick<SessionRunState, "cancelTargetRunId" | "isInCreateWindow">,
  pendingSubmission: PendingSessionSubmission | null,
  isStopping: boolean,
): CancelAction {
  if (isStopping) {
    return { type: "none" };
  }
  if (state.cancelTargetRunId !== null) {
    return { type: "cancel-run", runId: state.cancelTargetRunId };
  }
  if (state.isInCreateWindow) {
    return {
      type: "cancel-create",
      requestId: pendingSubmission?.requestId ?? null,
    };
  }
  return { type: "none" };
}
