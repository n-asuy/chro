import type { StoredTask } from "../types";

/**
 * Visual marker shown to the left of the timestamp in session lists.
 * - "failed": the run crashed or exited non-zero (e.g. the desktop app was
 *   closed mid-session and the orphan run was recovered as `failed` on the
 *   next server start).
 * - "completed": the run finished successfully.
 * `null` means no dot: the task is running (a spinner is shown instead), is
 * not in a terminal state, or the user has already seen its latest result.
 */
export type TaskStatusDotKind = "failed" | "completed" | null;

type TaskReadFields = Pick<
  StoredTask,
  "status" | "active_session_id" | "updated_at"
>;

/**
 * Derive the unread status dot for a task.
 *
 * A dot appears only when a task reached a terminal state (`completed` /
 * `failed`) and the user has not viewed it since its last update. Opening the
 * task records a view (see {@link useSessionReadStore}), which clears the dot.
 *
 * `updated_at` is the read watermark: it advances when a run completes, so a
 * task that finishes after you last looked at it surfaces as unread again.
 */
export function deriveTaskStatusDot(
  task: TaskReadFields,
  lastViewedAt: string | null | undefined,
): TaskStatusDotKind {
  // A running task shows the spinner, never an unread dot.
  if (task.active_session_id) return null;

  if (task.status !== "completed" && task.status !== "failed") return null;

  if (hasViewedSince(lastViewedAt, task.updated_at)) return null;

  return task.status === "failed" ? "failed" : "completed";
}

function hasViewedSince(
  lastViewedAt: string | null | undefined,
  updatedAt: string,
): boolean {
  if (!lastViewedAt) return false;
  const viewed = new Date(lastViewedAt).getTime();
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(viewed) || Number.isNaN(updated)) return false;
  return viewed >= updated;
}
