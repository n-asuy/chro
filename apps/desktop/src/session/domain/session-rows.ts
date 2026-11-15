import type { StoredTask } from "../types";
import { deriveSessionState } from "./session-grouping";

/**
 * One rendered line of a left-panel section. A flat list is all top-level
 * rows; with delegation nesting on, a delegated session sits under the session
 * that delegated it, one level deeper.
 */
export interface SessionListRow {
  task: StoredTask;
  /** Nesting level, 0 at the top of the section. */
  depth: number;
  /** Id of the row this one sits under; null at the top level. */
  parentId: string | null;
  /** Sessions nested under this row at any depth, shown or not. */
  descendantCount: number;
  /** Whether the nested sessions are shown. False for a leaf. */
  expanded: boolean;
  /** Direct children shown below this row that are running. Their own rows
   * carry the spinner, so the row's running-delegation count leaves them out. */
  shownRunningChildren: number;
  /** A session hidden under this collapsed row is waiting on the user. */
  hiddenNeedsInput: boolean;
}

export interface SessionRowsOptions {
  /** Nest delegated sessions under their delegator. Off keeps the list flat. */
  nest: boolean;
  /** Delegating sessions whose nested sessions are hidden. */
  collapsed: ReadonlySet<string>;
  /**
   * Where a tree sits among its siblings. `root` keeps the delegating
   * session's own position; `subtree` lifts the tree to the position of its
   * earliest member, so under a recency sort a tree whose delegated work is
   * active does not sink below idle sessions.
   */
  rank: "root" | "subtree";
}

const needsInput = (task: StoredTask) =>
  deriveSessionState(task) === "needs_input";

/**
 * Turn a section's sessions (already sorted by the caller) into rows. Only a
 * delegation edge nests, and only when the delegator is in the same list: a
 * session whose delegator is archived, pinned elsewhere, or in another project
 * stays at the top level, where its row still names the delegator. Sessions on
 * a delegation cycle have no well-defined parent and stay at the top level.
 */
export function buildSessionRows(
  tasks: readonly StoredTask[],
  options: SessionRowsOptions,
): SessionListRow[] {
  if (!options.nest) return tasks.map(topLevelRow);

  const indexOf = new Map(tasks.map((task, index) => [task.id, index]));
  const listedParent = (task: StoredTask): string | null => {
    const parent = task.delegated_from_id;
    return parent && indexOf.has(parent) ? parent : null;
  };
  const onCycle = (task: StoredTask): boolean => {
    const seen = new Set<string>();
    let at = listedParent(task);
    while (at !== null && !seen.has(at)) {
      if (at === task.id) return true;
      seen.add(at);
      at = listedParent(tasks[indexOf.get(at) as number]);
    }
    return false;
  };

  const roots: StoredTask[] = [];
  const children = new Map<string, StoredTask[]>();
  for (const task of tasks) {
    const parent = onCycle(task) ? null : listedParent(task);
    if (parent === null) {
      roots.push(task);
      continue;
    }
    const siblings = children.get(parent);
    if (siblings) siblings.push(task);
    else children.set(parent, [task]);
  }

  const subtreeRank = new Map<string, number>();
  const rankOf = (task: StoredTask): number => {
    const cached = subtreeRank.get(task.id);
    if (cached !== undefined) return cached;
    const own = indexOf.get(task.id) as number;
    const rank =
      options.rank === "subtree"
        ? Math.min(own, ...(children.get(task.id) ?? []).map(rankOf))
        : own;
    subtreeRank.set(task.id, rank);
    return rank;
  };
  const ordered = (level: readonly StoredTask[]) =>
    [...level].sort((a, b) => rankOf(a) - rankOf(b));

  const descendants = (task: StoredTask): StoredTask[] =>
    (children.get(task.id) ?? []).flatMap((kid) => [kid, ...descendants(kid)]);

  const rows: SessionListRow[] = [];
  const visit = (task: StoredTask, depth: number, parentId: string | null) => {
    const kids = ordered(children.get(task.id) ?? []);
    const hidden = descendants(task);
    const expanded = kids.length > 0 && !options.collapsed.has(task.id);
    rows.push({
      task,
      depth,
      parentId,
      descendantCount: hidden.length,
      expanded,
      shownRunningChildren: expanded
        ? kids.filter((kid) => kid.active_session_id).length
        : 0,
      hiddenNeedsInput: !expanded && hidden.some(needsInput),
    });
    if (expanded) for (const kid of kids) visit(kid, depth + 1, task.id);
  };
  for (const root of ordered(roots)) visit(root, 0, null);
  return rows;
}

function topLevelRow(task: StoredTask): SessionListRow {
  return {
    task,
    depth: 0,
    parentId: null,
    descendantCount: 0,
    expanded: false,
    shownRunningChildren: 0,
    hiddenNeedsInput: false,
  };
}

/**
 * Rows a long section shows before folding the rest behind "Show N more".
 * Folding only pays off when it hides at least two rows: the control is as
 * tall as a row, so hiding exactly one would save nothing.
 */
export const SESSION_PREVIEW_LIMIT = 5;

export interface SessionPreview {
  /** Rows to render, in the caller's order. */
  visible: SessionListRow[];
  /** Rows folded away; 0 means the section is shown in full. */
  hiddenCount: number;
}

/**
 * Fold a section down to its first rows. The focused session and sessions
 * waiting on the user (or a collapsed row hiding one) stay visible wherever
 * they sit, at their original position, so folding never hides where the user
 * is or what blocks on them. A row kept past the fold keeps the rows it is
 * nested under, so it never shows indented under nothing.
 */
export function previewSessions(
  rows: readonly SessionListRow[],
  isActive: (task: StoredTask) => boolean,
): SessionPreview {
  const parentOf = new Map(rows.map((row) => [row.task.id, row.parentId]));
  const kept = new Set<string>();
  rows.forEach((row, index) => {
    if (
      index < SESSION_PREVIEW_LIMIT ||
      isActive(row.task) ||
      needsInput(row.task) ||
      row.hiddenNeedsInput
    ) {
      for (
        let id: string | null | undefined = row.task.id;
        id && !kept.has(id);
        id = parentOf.get(id)
      ) {
        kept.add(id);
      }
    }
  });
  const visible = rows.filter((row) => kept.has(row.task.id));
  const hiddenCount = rows.length - visible.length;
  if (hiddenCount < 2) return { visible: [...rows], hiddenCount: 0 };
  return { visible, hiddenCount };
}
