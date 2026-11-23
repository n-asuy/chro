import { useInboxTasksStream } from "@/session/hooks/use-inbox-tasks-stream";
import { useSessionReadStore } from "@/session/state/session-read-store";
import type { StoredTask } from "@/session/types";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { type CapsuleDot, sessionDots } from "../domain/capsule-dots";
import { type CapsuleTiles, capsuleTiles } from "../domain/capsule-slots";
import { type EdgeSession, edgeSessions } from "../domain/edge-sessions";
import { useCapsuleSlotsStore } from "../state/capsule-slots-store";

export interface EdgeSessionsResult {
  /** Sessions in Unread (see `edgeSessions`). */
  sessions: EdgeSession[];
  /** The sessions on the edge and what is off it (see `capsuleTiles`). */
  tiles: CapsuleTiles;
  /** Every session that still exists, for the session list. */
  allDots: CapsuleDot[];
  /** Every task that exists, read or not, by id. */
  tasksById: ReadonlyMap<string, StoredTask>;
  /** Ids of {@link tasksById}, for the Unread pager. */
  existing: ReadonlySet<string>;
}

const NO_TILES: CapsuleTiles = { shown: [], hidden: 0, overflow: false };

/** The slot order, moved along as the sessions change (see `nextEdge`). */
function useCapsuleSlots(
  sessions: readonly CapsuleDot[],
  known: boolean,
  frozen: boolean,
): readonly string[] | null {
  const hydrated = useCapsuleSlotsStore((s) => s.hydrated);
  const hydrate = useCapsuleSlotsStore((s) => s.hydrate);
  const advance = useCapsuleSlotsStore((s) => s.advance);
  useEffect(() => {
    if (hydrate()) return;
    const id = window.setInterval(() => {
      if (hydrate()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [hydrate]);
  useLayoutEffect(() => {
    if (hydrated && known) advance(sessions, frozen);
  }, [hydrated, known, advance, sessions, frozen]);
  return useCapsuleSlotsStore((s) => s.edge?.slots ?? null);
}

/**
 * The cross-project task stream plus the read marks behind the session list's
 * unread dot, folded into what the edge toolbar shows. Nothing is shown until
 * the read marks are loaded (before that every finished session would look
 * unread), and no slot is decided until every session is known (before that
 * each would look deleted).
 *
 * @param frozen - Nothing joins the capsule or takes a slot there for now.
 */
export function useEdgeSessions(frozen: boolean): EdgeSessionsResult {
  const { tasks, hasSnapshot } = useInboxTasksStream(true);
  const viewedAt = useSessionReadStore((s) => s.viewedAt);
  const hydrated = useSessionReadStore((s) => s.hydrated);

  const tasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const existing = useMemo(() => new Set(tasksById.keys()), [tasksById]);
  const sessions = useMemo(
    () => (hydrated ? edgeSessions(tasks, viewedAt) : []),
    [hydrated, tasks, viewedAt],
  );
  const allDots = useMemo(
    () => (hydrated ? sessionDots(tasks, viewedAt) : []),
    [hydrated, tasks, viewedAt],
  );
  const slots = useCapsuleSlots(allDots, hydrated && hasSnapshot, frozen);
  const tiles = useMemo(
    () => (slots ? capsuleTiles(slots, allDots) : NO_TILES),
    [slots, allDots],
  );

  return { sessions, tiles, allDots, tasksById, existing };
}
