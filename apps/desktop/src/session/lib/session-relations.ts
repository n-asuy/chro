import type { StoredTask } from "../types";

/** A row of `task_context_refs`, as served by `/rpc/tasks/:id/context-refs`
 * (refs the task holds) and `/rpc/tasks/:id/referenced-by` (refs other tasks
 * hold that point at it). */
export type TaskContextRef = {
  id: string;
  task_id: string;
  task_session_id?: string | null;
  task_run_id?: string | null;
  kind: string;
  target_task_id?: string | null;
  target_session_id?: string | null;
  path?: string | null;
  branch?: string | null;
  mode: string;
  label?: string | null;
  metadata_json?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/**
 * How a counterpart relates to the session, read from the session's side.
 * Listed strongest first: one counterpart shows once, under the strongest
 * relation it has.
 */
export const SESSION_RELATIONS = [
  "delegated_to",
  "delegated_from",
  "continued_from",
  "continued_in",
  "uses",
  "referenced_by",
] as const;

export type SessionRelationKind = (typeof SESSION_RELATIONS)[number];

/** Outcome of a delegated session, shown next to `delegated_to` only. */
export type DelegationState = "running" | "done" | "failed" | null;

export type SessionRelation = {
  key: string;
  relation: SessionRelationKind;
  title: string;
  /** Set for session counterparts. */
  taskId?: string;
  /** Set for file and directory counterparts. */
  path?: string;
  isDirectory?: boolean;
  state: DelegationState;
};

const OUTGOING: Record<string, SessionRelationKind> = {
  delegate: "delegated_from",
  handoff: "delegated_to",
  fork: "continued_from",
};

const INCOMING: Record<string, SessionRelationKind> = {
  delegate: "delegated_to",
  handoff: "delegated_from",
  fork: "continued_in",
};

const rank = (relation: SessionRelationKind) =>
  SESSION_RELATIONS.indexOf(relation);

const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8);

const pathTitle = (path: string) =>
  path.split("/").filter(Boolean).pop() || path;

type Edge = {
  relation: SessionRelationKind;
  taskId: string;
  /** Snapshot of the counterpart's title. Only an outgoing edge has one: an
   * incoming edge's label describes this session, not the counterpart. */
  snapshot: string | null;
  handedOff: boolean;
};

function delegationState(
  task: StoredTask | undefined,
  handedOff: boolean,
): DelegationState {
  if (task?.active_session_id) return "running";
  if (task?.status === "failed") return "failed";
  if (task?.status === "completed" || handedOff) return "done";
  return null;
}

/**
 * Collapse a session's context-ref edges into one row per counterpart.
 *
 * Delegation writes two edges for one relationship (the delegated session's
 * `delegate` edge and the delegating session's `handoff` edge), and a
 * counterpart can also be referenced on top of being delegated to, so rows are
 * keyed by counterpart and keep the strongest relation. Rows are ordered by
 * relation, with running delegations first among `delegated_to`.
 */
export function sessionRelations(
  taskId: string,
  outgoing: readonly TaskContextRef[],
  incoming: readonly TaskContextRef[],
  tasksById: Readonly<Record<string, StoredTask>>,
): SessionRelation[] {
  const edges = new Map<string, Edge>();
  const paths = new Map<string, SessionRelation>();

  const addEdge = (edge: Edge) => {
    if (edge.taskId === taskId) return;
    const existing = edges.get(edge.taskId);
    if (!existing) {
      edges.set(edge.taskId, edge);
      return;
    }
    const stronger =
      rank(edge.relation) < rank(existing.relation) ? edge : existing;
    edges.set(edge.taskId, {
      ...stronger,
      snapshot: existing.snapshot ?? edge.snapshot,
      handedOff: existing.handedOff || edge.handedOff,
    });
  };

  for (const ref of outgoing) {
    const relation = OUTGOING[ref.kind] ?? "uses";
    if (ref.target_task_id) {
      addEdge({
        relation,
        taskId: ref.target_task_id,
        snapshot: ref.label?.trim() || null,
        handedOff: ref.kind === "handoff",
      });
      continue;
    }
    const path = ref.path?.trim();
    if (path && !paths.has(path)) {
      paths.set(path, {
        key: `path:${path}`,
        relation: "uses",
        title: pathTitle(path),
        path,
        isDirectory: ref.kind === "directory",
        state: null,
      });
    }
  }

  for (const ref of incoming) {
    addEdge({
      relation: INCOMING[ref.kind] ?? "referenced_by",
      taskId: ref.task_id,
      snapshot: null,
      handedOff: false,
    });
  }

  const taskRows = [...edges.values()].map((edge): SessionRelation => {
    const task = tasksById[edge.taskId];
    return {
      key: `task:${edge.taskId}`,
      relation: edge.relation,
      title: task?.title?.trim() || edge.snapshot || shortId(edge.taskId),
      taskId: edge.taskId,
      state:
        edge.relation === "delegated_to"
          ? delegationState(task, edge.handedOff)
          : null,
    };
  });

  // Tasks before paths within a relation; Array.prototype.sort is stable, so
  // edge order (sort_order for outgoing, newest first for incoming) survives.
  return [...taskRows, ...paths.values()].sort(
    (a, b) =>
      rank(a.relation) - rank(b.relation) ||
      Number(b.state === "running") - Number(a.state === "running"),
  );
}

/**
 * The session together with every session it relates to, in either
 * direction, so the left panel can mark them as one group. Empty when the
 * session relates to no other session: a group of one marks nothing.
 */
export function relatedSessionGroup(
  taskId: string,
  outgoing: readonly TaskContextRef[],
  incoming: readonly TaskContextRef[],
): ReadonlySet<string> {
  const group = new Set<string>();
  for (const ref of outgoing) {
    if (ref.target_task_id) group.add(ref.target_task_id);
  }
  for (const ref of incoming) group.add(ref.task_id);
  group.delete(taskId);
  if (group.size > 0) group.add(taskId);
  return group;
}

/**
 * For each task, how many of the sessions it delegated are running right now.
 * Tasks with none are absent.
 */
export function runningDelegationCounts(
  tasks: readonly StoredTask[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.delegated_from_id || !task.active_session_id) continue;
    counts.set(
      task.delegated_from_id,
      (counts.get(task.delegated_from_id) ?? 0) + 1,
    );
  }
  return counts;
}
