import { deriveTaskStatusDot } from "@/session/domain/task-read-state";
import type { StoredTask } from "@/session/types";

/**
 * The capsule's dots: one per session that still exists. Separate from
 * Unread (see `edge-sessions.ts`): reading a session changes its dot's
 * colour, never removes it; only archiving does.
 */

/** Archived tasks are stored with this status. */
const ARCHIVED_STATUS = "cancelled";

/** Dots on the capsule before the rest collapse into "+N". */
export const CAPSULE_DOT_CAP = 8;

/**
 * The mock's four dot states: a blue spinner while running, amber (breathing)
 * when the session needs the user, green when it finished and is unread, a
 * small grey dot otherwise.
 */
export type CapsuleDotStatus = "running" | "waiting" | "done" | "idle";

export interface CapsuleDot {
  task: StoredTask;
  status: CapsuleDotStatus;
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
const byRecentActivity = (a: CapsuleDot, b: CapsuleDot) =>
  b.task.updated_at.localeCompare(a.task.updated_at);

/**
 * The dots the capsule shows: sessions that need the user are always shown;
 * the remaining places go to the most recently active sessions. They are
 * displayed in creation order, so a dot never moves when its session updates
 * and a new session joins at the end. `hidden` counts the rest ("+N").
 */
export function capsuleDots(
  tasks: readonly StoredTask[],
  viewedAt: Readonly<Record<string, string>>,
  cap: number,
): { shown: CapsuleDot[]; hidden: number } {
  const all: CapsuleDot[] = [];
  for (const task of tasks) {
    const status = capsuleDotStatus(task, viewedAt[task.id]);
    if (status) all.push({ task, status });
  }
  const urgent = all.filter((dot) => dot.status === "waiting");
  const rest = all
    .filter((dot) => dot.status !== "waiting")
    .sort(byRecentActivity)
    .slice(0, Math.max(0, cap - urgent.length));
  const shown = [...urgent, ...rest].sort(byCreation);
  return { shown, hidden: all.length - shown.length };
}
