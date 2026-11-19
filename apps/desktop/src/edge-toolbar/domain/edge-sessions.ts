import { deriveTaskStatusDot } from "@/session/domain/task-read-state";
import type { StoredTask } from "@/session/types";

/**
 * How a session shows on the edge toolbar. Derived only from state chro
 * already keeps: `awaiting_input` and `active_session_id` on the task record,
 * and the read marks behind the session list's unread dot.
 *
 * - `waiting`: the agent is blocked on a question or an approval.
 * - `running`: a run is live.
 * - `completed` / `failed`: the run finished and the user has not seen it.
 */
export type EdgeSessionState = "waiting" | "running" | "completed" | "failed";

export interface EdgeSession {
  task: StoredTask;
  state: EdgeSessionState;
}

/** Archived tasks are stored with this status. */
const ARCHIVED_STATUS = "cancelled";

/** `null` means the session has nothing to show on the edge. */
export function deriveEdgeSessionState(
  task: StoredTask,
  lastViewedAt: string | null | undefined,
): EdgeSessionState | null {
  if (task.status === ARCHIVED_STATUS) return null;
  if (task.awaiting_input) return "waiting";
  if (task.active_session_id) return "running";
  const dot = deriveTaskStatusDot(task, lastViewedAt);
  if (dot === "completed" || dot === "failed") return dot;
  return null;
}

/**
 * Where a session is, whether or not it is on the edge: the status line of a
 * panel that stays open after its session was read. A session that is neither
 * waiting, running nor failed reads as finished.
 */
export function panelSessionState(task: StoredTask): EdgeSessionState {
  if (task.awaiting_input) return "waiting";
  if (task.active_session_id) return "running";
  return task.status === "failed" ? "failed" : "completed";
}

/**
 * The sessions the edge toolbar shows, oldest first by creation: a session
 * that starts joins at the end of the capsule, so no dot ever moves (not when
 * a session updates, not when another one joins).
 */
export function edgeSessions(
  tasks: readonly StoredTask[],
  viewedAt: Readonly<Record<string, string>>,
): EdgeSession[] {
  const sessions: EdgeSession[] = [];
  for (const task of tasks) {
    const state = deriveEdgeSessionState(task, viewedAt[task.id]);
    if (state) sessions.push({ task, state });
  }
  return sessions.sort((a, b) =>
    a.task.created_at.localeCompare(b.task.created_at),
  );
}

/** Whether a session in this state needs the user (it belongs in Unread). */
export function needsUser(state: EdgeSessionState): boolean {
  return state !== "running";
}

/**
 * The toolbar's dot for each state, in the mock's three colours: amber when
 * the session needs the user (a question, an approval or a failed run), a
 * blue spinner while it runs, green when it finished.
 */
export type EdgeDotStatus = "waiting" | "running" | "done";

const DOT_STATUS: Record<EdgeSessionState, EdgeDotStatus> = {
  waiting: "waiting",
  running: "running",
  completed: "done",
  failed: "waiting",
};

export function edgeDotStatus(state: EdgeSessionState): EdgeDotStatus {
  return DOT_STATUS[state];
}

const URGENCY: Record<EdgeSessionState, number> = {
  waiting: 0,
  failed: 1,
  completed: 2,
  running: 3,
};

/** The Unread pager's list and position, while it is open. */
export interface UnreadPagerView {
  order: readonly string[];
  cursorId: string | null;
}

/**
 * The Unread button's badge: how many items Unread holds and the colour of
 * the one that matters most. While the pager is open it holds exactly what
 * the pager lists, read items kept in place included, so the badge and the
 * pager never disagree. The colour follows the item on screen while it still
 * needs the user, otherwise the most urgent one.
 */
export function unreadBadge(
  sessions: readonly EdgeSession[],
  pager: UnreadPagerView | null,
): { count: number; status: EdgeDotStatus } | null {
  const pending = sessions.filter((s) => needsUser(s.state));
  const count = pager ? pager.order.length : pending.length;
  if (count === 0) return null;

  const listed = pager ? new Set(pager.order) : null;
  const candidates = listed
    ? pending.filter((s) => listed.has(s.task.id))
    : pending;
  const current = candidates.find((s) => s.task.id === pager?.cursorId);
  const front =
    current ??
    [...candidates].sort((a, b) => URGENCY[a.state] - URGENCY[b.state])[0];
  return { count, status: front ? edgeDotStatus(front.state) : "done" };
}

/**
 * Where the pager is: a row of dots with the current one marked while they
 * fit in the header, a "3 / 12" count beyond that. Nothing for one item.
 */
export type PagerIndicator = {
  kind: "dots" | "count";
  total: number;
  /** -1 when the cursor is not in the list. */
  index: number;
};

export function pagerIndicator(
  order: readonly string[],
  cursorId: string | null,
  maxDots: number,
): PagerIndicator | null {
  if (order.length <= 1) return null;
  return {
    kind: order.length <= maxDots ? "dots" : "count",
    total: order.length,
    index: cursorId ? order.indexOf(cursorId) : -1,
  };
}

function byUpdatedAt(direction: 1 | -1) {
  return (a: EdgeSession, b: EdgeSession) =>
    direction * a.task.updated_at.localeCompare(b.task.updated_at);
}

/**
 * The Unread pager's order, recomputed whenever sessions change while it is
 * open. Sessions waiting on a question or approval come first (longest
 * waiting first), then unseen results (most recent first).
 *
 * An item the pager has shown keeps its place until the pager closes, even
 * once it no longer needs the user: a result is marked read the moment it is
 * shown, and an answered question resumes the agent, and neither should
 * vanish from under the person reading it. Items that arrive later are slotted
 * in without moving what is already listed: new waiting sessions after the
 * listed waiting ones, new results at the end.
 *
 * Returns `previous` itself when nothing changed.
 */
export function nextUnreadOrder({
  previous,
  sessions,
  shown,
  existing,
}: {
  previous: readonly string[];
  /** The edge sessions (see {@link edgeSessions}). */
  sessions: readonly EdgeSession[];
  /** Items the pager has shown since it opened. */
  shown: ReadonlySet<string>;
  /** Every task that still exists, read or not. */
  existing: ReadonlySet<string>;
}): string[] {
  const byId = new Map(sessions.map((s) => [s.task.id, s]));
  const kept = previous.filter((id) => {
    if (shown.has(id)) return existing.has(id);
    const session = byId.get(id);
    return session !== undefined && needsUser(session.state);
  });
  const listed = new Set(kept);
  const fresh = sessions.filter(
    (s) => needsUser(s.state) && !listed.has(s.task.id),
  );
  const freshWaiting = fresh
    .filter((s) => s.state === "waiting")
    .sort(byUpdatedAt(1))
    .map((s) => s.task.id);
  const freshResults = fresh
    .filter((s) => s.state !== "waiting")
    .sort(byUpdatedAt(-1))
    .map((s) => s.task.id);

  let lastWaiting = -1;
  kept.forEach((id, index) => {
    if (byId.get(id)?.state === "waiting") lastWaiting = index;
  });
  const next = [
    ...kept.slice(0, lastWaiting + 1),
    ...freshWaiting,
    ...kept.slice(lastWaiting + 1),
    ...freshResults,
  ];

  const unchanged =
    next.length === previous.length &&
    next.every((id, index) => id === previous[index]);
  return unchanged ? (previous as string[]) : next;
}

/**
 * The item the pager shows. It follows its item by id, so items slotted in
 * around it never move what the person is reading. When the item left the
 * list, the one that took its place is shown.
 */
export function resolveCursor(
  order: readonly string[],
  currentId: string | null,
  lastIndex: number,
): string | null {
  if (order.length === 0) return null;
  if (currentId && order.includes(currentId)) return currentId;
  const index = Math.min(Math.max(lastIndex, 0), order.length - 1);
  return order[index] ?? null;
}

/** J/K: one item back or forward, stopping at the ends. */
export function stepCursor(
  order: readonly string[],
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const index = currentId ? order.indexOf(currentId) : -1;
  const next = Math.min(Math.max(index + delta, 0), order.length - 1);
  return order[next] ?? null;
}
