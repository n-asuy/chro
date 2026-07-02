import type { StoredTask } from "../types";

/**
 * How the cross-project session list is folded into sections. A single flat
 * stream of sessions is bucketed by one axis at view time, so "project" is just
 * one option among several rather than a structural container:
 *
 * - `none`    one headerless list (every session, ordered by the caller)
 * - `project` one section per owning project
 * - `status`  one section per derived run state
 * - `date`    one section per recency bucket
 */
export type SessionGroupMode = "none" | "project" | "status" | "date";

export const SESSION_GROUP_MODES: readonly SessionGroupMode[] = [
  "none",
  "project",
  "status",
  "date",
];

export const isSessionGroupMode = (value: unknown): value is SessionGroupMode =>
  value === "none" ||
  value === "project" ||
  value === "status" ||
  value === "date";

/**
 * Derived run state used by the `status` grouping, ordered most-actionable
 * first so sessions waiting on the user float to the top.
 */
export type SessionState =
  | "needs_input"
  | "running"
  | "pending"
  | "completed"
  | "failed"
  | "cancelled";

const SESSION_STATE_ORDER: readonly SessionState[] = [
  "needs_input",
  "running",
  "pending",
  "completed",
  "failed",
  "cancelled",
];

/**
 * Collapse a task's persisted status plus its live flags into a single state.
 * Awaiting-input wins over running (the agent is blocked on the user), and an
 * active session reads as running regardless of the stored status.
 */
export function deriveSessionState(task: StoredTask): SessionState {
  if (task.awaiting_input) return "needs_input";
  if (task.active_session_id) return "running";
  switch (task.status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "in_progress":
      return "running";
    default:
      return "pending";
  }
}

/** Recency bucket used by the `date` grouping, ordered newest first. */
export type DateBucket = "today" | "yesterday" | "last7" | "last30" | "older";

const DATE_BUCKET_ORDER: readonly DateBucket[] = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "older",
];

const DAY_MS = 86_400_000;

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Bucket a timestamp by calendar distance from the start of today. Unparseable
 * timestamps fall back to `older` so they never masquerade as recent.
 */
export function deriveDateBucket(updatedAt: string, now: number): DateBucket {
  const at = new Date(updatedAt).getTime();
  if (Number.isNaN(at)) return "older";
  const today = startOfLocalDay(now);
  if (at >= today) return "today";
  if (at >= today - DAY_MS) return "yesterday";
  if (at >= today - 7 * DAY_MS) return "last7";
  if (at >= today - 30 * DAY_MS) return "last30";
  return "older";
}

/**
 * Localized labels injected by the caller so this module stays i18n-agnostic
 * and fully unit-testable.
 */
export interface GroupLabels {
  state: Record<SessionState, string>;
  dateBucket: Record<DateBucket, string>;
  unknownProject: string;
}

export interface SessionGroup {
  /** Stable key for React keys and persisted collapse state. */
  key: string;
  /** Final display text; empty for the headerless `none` group. */
  label: string;
  /** Owning project id in `project` mode (for header actions), else null. */
  projectId: string | null;
  /** Sessions in this section, in the caller's input order. */
  tasks: StoredTask[];
}

export interface GroupSessionsInput {
  /** Sessions, already sorted by the caller (group order is independent). */
  tasks: StoredTask[];
  mode: SessionGroupMode;
  /** project id -> display name, for `project` labels. */
  projectNames: Record<string, string>;
  /**
   * Projects to always render as sections in `project` mode, in this order,
   * even when they currently have no sessions (open workspaces stay visible).
   */
  pinnedProjects?: readonly { id: string; name: string }[];
  /** Reference "now" (ms) for `date` bucketing. */
  now: number;
  labels: GroupLabels;
}

/**
 * Membership test for the cross-project inbox. A session belongs when its
 * owning project is open in the workspace, or when it is a scratch ("General")
 * session that surfaces without its project ever being registered in the
 * sidebar. Sessions whose project the user removed from the sidebar fall away
 * instead of resurfacing in a catch-all section at the bottom of the list.
 */
export function isInboxSession(
  task: StoredTask,
  openProjectIds: ReadonlySet<string>,
  scratchProjectIds: ReadonlySet<string>,
): boolean {
  return (
    openProjectIds.has(task.project_id) ||
    scratchProjectIds.has(task.project_id)
  );
}

function bucketByKey(tasks: StoredTask[], keyOf: (task: StoredTask) => string) {
  const byKey = new Map<string, StoredTask[]>();
  for (const task of tasks) {
    const key = keyOf(task);
    const list = byKey.get(key);
    if (list) list.push(task);
    else byKey.set(key, [task]);
  }
  return byKey;
}

function groupByProject(input: GroupSessionsInput): SessionGroup[] {
  const { tasks, projectNames, pinnedProjects = [], labels } = input;
  const byProject = bucketByKey(tasks, (task) => task.project_id);
  const groups: SessionGroup[] = [];
  const seen = new Set<string>();

  const push = (projectId: string, name: string | undefined) => {
    seen.add(projectId);
    groups.push({
      key: `project:${projectId}`,
      label: name ?? projectNames[projectId] ?? labels.unknownProject,
      projectId,
      tasks: byProject.get(projectId) ?? [],
    });
  };

  for (const pinned of pinnedProjects) push(pinned.id, pinned.name);

  // Projects with sessions that aren't pinned, appended alphabetically by name.
  const extra = [...byProject.keys()]
    .filter((id) => !seen.has(id))
    .sort((a, b) =>
      (projectNames[a] ?? labels.unknownProject).localeCompare(
        projectNames[b] ?? labels.unknownProject,
      ),
    );
  for (const id of extra) push(id, undefined);

  return groups;
}

function groupByStatus(input: GroupSessionsInput): SessionGroup[] {
  const { tasks, labels } = input;
  const byState = bucketByKey(tasks, (task) => deriveSessionState(task));
  return SESSION_STATE_ORDER.filter((state) => byState.has(state)).map(
    (state) => ({
      key: `status:${state}`,
      label: labels.state[state],
      projectId: null,
      tasks: byState.get(state) ?? [],
    }),
  );
}

function groupByDate(input: GroupSessionsInput): SessionGroup[] {
  const { tasks, now, labels } = input;
  const byBucket = bucketByKey(tasks, (task) =>
    deriveDateBucket(task.updated_at, now),
  );
  return DATE_BUCKET_ORDER.filter((bucket) => byBucket.has(bucket)).map(
    (bucket) => ({
      key: `date:${bucket}`,
      label: labels.dateBucket[bucket],
      projectId: null,
      tasks: byBucket.get(bucket) ?? [],
    }),
  );
}

/**
 * Fold a flat session list into ordered, collapsible sections by the chosen
 * axis. Pure and deterministic: within-section order mirrors the input, so
 * sorting is the caller's responsibility.
 */
export function groupSessions(input: GroupSessionsInput): SessionGroup[] {
  switch (input.mode) {
    case "none":
      return [{ key: "all", label: "", projectId: null, tasks: input.tasks }];
    case "project":
      return groupByProject(input);
    case "status":
      return groupByStatus(input);
    case "date":
      return groupByDate(input);
  }
}
