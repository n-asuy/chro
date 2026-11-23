import type { CapsuleDot } from "./capsule-dots";

/**
 * Which sessions are on the edge, and where. Membership, position and colour
 * are separate: a session joins when it starts running, starts waiting on
 * the user or finishes unread; its slot is where it joined; and its state
 * only colours it. Reading a session changes its ring and nothing else.
 */

/** What a session joins the edge for. */
type Join = "waiting" | "running" | "done";

export interface CapsuleEdge {
  /** The sessions on the edge, in slot order. */
  slots: readonly string[];
  /**
   * The sessions waiting in "+N" for a slot to free, with what they joined
   * for. They take no other session's slot any more, so reading a tile never
   * hands its slot to one of them.
   */
  line: Readonly<Record<string, Join>>;
}

/** Sessions on the edge; the rest are counted in "+N". */
export const CAPSULE_SLOTS = 8;

const time = (iso: string) => Date.parse(iso);

/** Least recent activity first. */
const byActivity = (a: CapsuleDot, b: CapsuleDot) =>
  time(a.task.updated_at) - time(b.task.updated_at);

const isRead = (dot: CapsuleDot) => dot.status === "idle";
const needsAnswer = (dot: CapsuleDot) => dot.task.awaiting_input;

/** Why a session that is not read is on the edge; an unread failure is a result. */
function joinOf(dot: CapsuleDot): Join | null {
  if (isRead(dot)) return null;
  if (needsAnswer(dot)) return "waiting";
  return dot.status === "running" ? "running" : "done";
}

/** Longest unviewed first; a session never viewed comes before any other. */
const byViewed = (a: CapsuleDot, b: CapsuleDot) =>
  (a.viewedAt ? time(a.viewedAt) : 0) - (b.viewedAt ? time(b.viewedAt) : 0) ||
  byActivity(a, b);

/** The member that gives up its slot to `newcomer`, if any does. */
function replaced(
  members: readonly CapsuleDot[],
  newcomer: CapsuleDot,
): CapsuleDot | undefined {
  const oldest = (
    which: (dot: CapsuleDot) => boolean,
    order: (a: CapsuleDot, b: CapsuleDot) => number,
  ) => members.filter(which).sort(order)[0];
  const read = oldest(isRead, byViewed);
  if (read || !needsAnswer(newcomer)) return read;
  return (
    oldest((dot) => joinOf(dot) === "done", byActivity) ??
    oldest((dot) => joinOf(dot) === "running", byActivity)
  );
}

/** The edge before it ever held a session. */
function firstSlots(sessions: readonly CapsuleDot[]): string[] {
  const rank = (dot: CapsuleDot) =>
    ["waiting", "running", "done", "idle"].indexOf(dot.status);
  return [...sessions]
    .sort((a, b) => rank(a) - rank(b) || byActivity(b, a))
    .slice(0, CAPSULE_SLOTS)
    .map((dot) => dot.task.id);
}

/** The sessions off the edge that are not read, with what they joined for. */
function lineBeside(
  slots: readonly string[],
  sessions: readonly CapsuleDot[],
): Record<string, Join> {
  const onEdge = new Set(slots);
  const line: Record<string, Join> = {};
  for (const dot of sessions) {
    const join = joinOf(dot);
    if (join && !onEdge.has(dot.task.id)) line[dot.task.id] = join;
  }
  return line;
}

function sameLine(a: CapsuleEdge["line"], b: CapsuleEdge["line"]): boolean {
  const ids = Object.keys(a);
  return (
    ids.length === Object.keys(b).length && ids.every((id) => a[id] === b[id])
  );
}

const sameSlots = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The slots once every session off the edge that is not read has had its
 * turn: free slots go to whoever waits on the user, then in the order things
 * happened; past that, a session that just joined (it is not in the line for
 * the same reason) may replace another in place (see `replaced`).
 */
function settle(
  kept: readonly string[],
  line: CapsuleEdge["line"],
  byId: ReadonlyMap<string, CapsuleDot>,
): string[] {
  const slots = [...kept];
  const onEdge = new Set(slots);
  const outside = [...byId.values()]
    .filter((dot) => !isRead(dot) && !onEdge.has(dot.task.id))
    .sort(byActivity);
  const ranked = [
    ...outside.filter(needsAnswer),
    ...outside.filter((dot) => !needsAnswer(dot)),
  ];
  const joined = new Set(
    ranked.slice(0, Math.max(0, CAPSULE_SLOTS - slots.length)),
  );
  slots.push(
    ...outside.filter((dot) => joined.has(dot)).map((dot) => dot.task.id),
  );
  for (const dot of ranked) {
    if (joined.has(dot) || line[dot.task.id] === joinOf(dot)) continue;
    const members = slots
      .map((id) => byId.get(id))
      .filter((member) => member !== undefined)
      .filter((member) => !joined.has(member));
    const leaving = replaced(members, dot);
    if (!leaving) continue;
    slots[slots.indexOf(leaving.task.id)] = dot.task.id;
    joined.add(dot);
  }
  return slots;
}

/**
 * The next state of the edge. `previous` is null when nothing was ever
 * stored. While `frozen` (the pointer is on the toolbar, or a panel is open)
 * sessions that no longer exist still leave, but nothing is added or
 * replaced; sessions that join meanwhile get their turn afterwards. Returns
 * `previous` itself when nothing changes.
 */
export function nextEdge(
  previous: CapsuleEdge | null,
  sessions: readonly CapsuleDot[],
  frozen: boolean,
): CapsuleEdge {
  if (!previous) {
    const slots = firstSlots(sessions);
    return { slots, line: lineBeside(slots, sessions) };
  }
  const byId = new Map(sessions.map((dot) => [dot.task.id, dot]));
  const kept = previous.slots.filter((id) => byId.has(id));
  const slots = frozen ? kept : settle(kept, previous.line, byId);
  const line = frozen ? previous.line : lineBeside(slots, sessions);
  return sameSlots(slots, previous.slots) && sameLine(line, previous.line)
    ? previous
    : { slots, line };
}

const JOINS: readonly unknown[] = ["waiting", "running", "done"];

/** A stored edge, or null when the value is not one. */
export function parseEdge(value: unknown): CapsuleEdge | null {
  if (!value || typeof value !== "object") return null;
  const { slots, line } = value as { slots?: unknown; line?: unknown };
  if (!Array.isArray(slots)) return null;
  if (!slots.every((id) => typeof id === "string")) return null;
  const entries = line && typeof line === "object" ? Object.entries(line) : [];
  return {
    slots: [...new Set<string>(slots)].slice(0, CAPSULE_SLOTS),
    line: Object.fromEntries(
      entries.filter((entry): entry is [string, Join] =>
        JOINS.includes(entry[1]),
      ),
    ),
  };
}

export interface CapsuleTiles {
  /** The sessions on the edge, in slot order. */
  shown: CapsuleDot[];
  /** Sessions off the edge ("+N"). */
  hidden: number;
  /** A session off the edge is not read: the collapsed tab's tick. */
  overflow: boolean;
}

/** What the capsule and the collapsed tab show for these slots. */
export function capsuleTiles(
  slots: readonly string[],
  sessions: readonly CapsuleDot[],
): CapsuleTiles {
  const byId = new Map(sessions.map((dot) => [dot.task.id, dot]));
  const shown = slots
    .map((id) => byId.get(id))
    .filter((dot): dot is CapsuleDot => !!dot);
  const onEdge = new Set(shown);
  const off = sessions.filter((dot) => !onEdge.has(dot));
  return {
    shown,
    hidden: off.length,
    overflow: off.some((dot) => !isRead(dot)),
  };
}
