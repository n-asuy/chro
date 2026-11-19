import { useInboxTasksStream } from "@/session/hooks/use-inbox-tasks-stream";
import { useSessionReadStore } from "@/session/state/session-read-store";
import type { StoredTask } from "@/session/types";
import { useMemo } from "react";
import {
  CAPSULE_DOT_CAP,
  type CapsuleDot,
  capsuleDots,
} from "../domain/capsule-dots";
import { type EdgeSession, edgeSessions } from "../domain/edge-sessions";

export interface EdgeSessionsResult {
  /** Sessions in Unread (see `edgeSessions`). */
  sessions: EdgeSession[];
  /** The capsule's dots: capped, plus how many did not fit. */
  dots: { shown: CapsuleDot[]; hidden: number };
  /** Every session that still exists, for the session list. */
  allDots: CapsuleDot[];
  /** Every task that exists, read or not, by id. */
  tasksById: ReadonlyMap<string, StoredTask>;
  /** Ids of {@link tasksById}, for the Unread pager. */
  existing: ReadonlySet<string>;
}

const NO_DOTS = { shown: [] as CapsuleDot[], hidden: 0 };

/**
 * The cross-project task stream plus the read marks behind the session list's
 * unread dot, folded into what the edge toolbar shows. Nothing is shown until
 * the read marks are loaded: before that every finished session would look
 * unread.
 */
export function useEdgeSessions(): EdgeSessionsResult {
  const { tasks } = useInboxTasksStream(true);
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
  const dots = useMemo(
    () => (hydrated ? capsuleDots(tasks, viewedAt, CAPSULE_DOT_CAP) : NO_DOTS),
    [hydrated, tasks, viewedAt],
  );
  const allDots = useMemo(
    () =>
      hydrated
        ? capsuleDots(tasks, viewedAt, Number.POSITIVE_INFINITY).shown
        : [],
    [hydrated, tasks, viewedAt],
  );

  return { sessions, dots, allDots, tasksById, existing };
}
