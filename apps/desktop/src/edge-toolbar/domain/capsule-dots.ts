import { deriveTaskStatusDot } from "@/session/domain/task-read-state";
import type { StoredTask } from "@/session/types";

/**
 * Each session's state as a dot: one per session that still exists.
 * Separate from Unread (see `edge-sessions.ts`): reading a session changes
 * its dot's colour, never removes it; only archiving does.
 */

/** Archived tasks are stored with this status. */
const ARCHIVED_STATUS = "cancelled";

/**
 * The mock's four dot states: a blue spinner while running, amber (breathing)
 * when the session needs the user, green when it finished and is unread, a
 * small grey dot otherwise.
 */
export type CapsuleDotStatus = "running" | "waiting" | "done" | "idle";

export interface CapsuleDot {
  task: StoredTask;
  status: CapsuleDotStatus;
  /** When the user last opened it here; null when they never did. */
  viewedAt: string | null;
}

/**
 * A session's dot, from the same rule as the session list's status marker
 * (`deriveTaskStatusDot`): running, waiting on the user, an unread failure
 * (amber, it needs the user) or an unread result (green). Everything else,
 * read results included, is grey. `null` for an archived session.
 */
export function capsuleDotStatus(
  task: StoredTask,
  lastViewedAt: string | null | undefined,
): CapsuleDotStatus | null {
  if (task.status === ARCHIVED_STATUS) return null;
  if (task.awaiting_input) return "waiting";
  if (task.active_session_id) return "running";
  const marker = deriveTaskStatusDot(task, lastViewedAt);
  if (marker === "failed") return "waiting";
  if (marker === "completed") return "done";
  return "idle";
}

const byCreation = (a: CapsuleDot, b: CapsuleDot) =>
  a.task.created_at.localeCompare(b.task.created_at);

/**
 * Every session that still exists with its state, in creation order (the
 * session list's order within a project; the capsule keeps its own
 * order, see `capsule-slots.ts`).
 */
export function sessionDots(
  tasks: readonly StoredTask[],
  viewedAt: Readonly<Record<string, string>>,
): CapsuleDot[] {
  const all: CapsuleDot[] = [];
  for (const task of tasks) {
    const viewed = viewedAt[task.id] ?? null;
    const status = capsuleDotStatus(task, viewed);
    if (status) all.push({ task, status, viewedAt: viewed });
  }
  return all.sort(byCreation);
}
