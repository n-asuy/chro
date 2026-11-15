import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import {
  type SessionListRow,
  buildSessionRows,
  previewSessions,
} from "../session-rows";

function task(overrides: Partial<StoredTask> & { id: string }): StoredTask {
  return {
    project_id: "p1",
    title: overrides.id,
    status: "completed",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    sort_order: 0,
    ...overrides,
  };
}

const child = (id: string, parent: string, extra: Partial<StoredTask> = {}) =>
  task({ id, delegated_from_id: parent, ...extra });

const NOTHING_COLLAPSED: ReadonlySet<string> = new Set();

const nested = (
  tasks: StoredTask[],
  options: {
    collapsed?: ReadonlySet<string>;
    rank?: "root" | "subtree";
  } = {},
) =>
  buildSessionRows(tasks, {
    nest: true,
    collapsed: options.collapsed ?? NOTHING_COLLAPSED,
    rank: options.rank ?? "root",
  });

const outline = (rows: readonly SessionListRow[]) =>
  rows.map((row) => `${"  ".repeat(row.depth)}${row.task.id}`);

describe("buildSessionRows without nesting", () => {
  it("keeps every session at the top level in input order", () => {
    const rows = buildSessionRows([task({ id: "a" }), child("b", "a")], {
      nest: false,
      collapsed: NOTHING_COLLAPSED,
      rank: "root",
    });
    expect(outline(rows)).toEqual(["a", "b"]);
    expect(rows.every((row) => row.parentId === null)).toBe(true);
    expect(rows.every((row) => row.descendantCount === 0)).toBe(true);
  });
});

describe("buildSessionRows with nesting", () => {
  it("places delegated sessions directly under the delegating one", () => {
    const rows = nested([
      child("b", "a"),
      task({ id: "x" }),
      task({ id: "a" }),
      child("c", "a"),
    ]);
    expect(outline(rows)).toEqual(["x", "a", "  b", "  c"]);
    expect(rows[2].parentId).toBe("a");
  });

  it("nests chains beyond one level", () => {
    const rows = nested([child("c", "b"), child("b", "a"), task({ id: "a" })]);
    expect(outline(rows)).toEqual(["a", "  b", "    c"]);
    expect(rows[0].descendantCount).toBe(2);
    expect(rows[1].descendantCount).toBe(1);
    expect(rows[2].descendantCount).toBe(0);
  });

  it("keeps a session at the top level when its delegator is not listed", () => {
    const rows = nested([child("b", "archived-parent"), task({ id: "a" })]);
    expect(outline(rows)).toEqual(["b", "a"]);
    expect(rows[0].parentId).toBeNull();
  });

  it("does not nest forks", () => {
    const rows = nested([
      task({ id: "a" }),
      task({ id: "f", forked_from_title: "a" }),
    ]);
    expect(outline(rows)).toEqual(["a", "f"]);
  });

  it("keeps sessions on a delegation cycle visible as top-level rows", () => {
    const rows = nested([
      child("a", "b"),
      child("b", "a"),
      child("c", "a"),
      child("self", "self"),
    ]);
    expect(outline(rows)).toEqual(["a", "  c", "b", "self"]);
  });

  it("orders each level by the earliest member of its subtree under subtree rank", () => {
    // Input is recency-ordered: the newest activity in a's tree is its child.
    const tasks = [child("b", "a"), task({ id: "x" }), task({ id: "a" })];
    expect(outline(nested(tasks, { rank: "subtree" }))).toEqual([
      "a",
      "  b",
      "x",
    ]);
    expect(outline(nested(tasks, { rank: "root" }))).toEqual(["x", "a", "  b"]);
  });

  it("hides the subtree of a collapsed session and reports what it hides", () => {
    const rows = nested(
      [
        task({ id: "a" }),
        child("b", "a"),
        child("c", "b", { awaiting_input: true }),
      ],
      { collapsed: new Set(["a"]) },
    );
    expect(outline(rows)).toEqual(["a"]);
    expect(rows[0]).toMatchObject({
      expanded: false,
      descendantCount: 2,
      hiddenNeedsInput: true,
    });
  });

  it("ignores a collapse entry on a session with nothing nested", () => {
    const rows = nested([task({ id: "a" })], { collapsed: new Set(["a"]) });
    expect(rows[0]).toMatchObject({ expanded: false, hiddenNeedsInput: false });
  });

  it("counts running children only while they are shown", () => {
    const tasks = [
      task({ id: "a" }),
      child("b", "a", { active_session_id: "run-b" }),
      child("c", "a"),
    ];
    expect(nested(tasks)[0].shownRunningChildren).toBe(1);
    expect(
      nested(tasks, { collapsed: new Set(["a"]) })[0].shownRunningChildren,
    ).toBe(0);
  });
});

describe("previewSessions", () => {
  const flat = (tasks: StoredTask[]) =>
    buildSessionRows(tasks, {
      nest: false,
      collapsed: NOTHING_COLLAPSED,
      rank: "root",
    });
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => task({ id: `t${i}` }));
  const ids = (rows: readonly SessionListRow[]) => rows.map((r) => r.task.id);
  const noneActive = () => false;

  it("shows a short section in full", () => {
    const rows = flat(many(3));
    const preview = previewSessions(rows, noneActive);
    expect(ids(preview.visible)).toEqual(ids(rows));
    expect(preview.hiddenCount).toBe(0);
  });

  it("does not fold away a single row", () => {
    const preview = previewSessions(flat(many(6)), noneActive);
    expect(preview.visible).toHaveLength(6);
    expect(preview.hiddenCount).toBe(0);
  });

  it("folds a long section to its first rows", () => {
    const preview = previewSessions(flat(many(9)), noneActive);
    expect(ids(preview.visible)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(preview.hiddenCount).toBe(4);
  });

  it("keeps the focused session visible past the fold", () => {
    const preview = previewSessions(flat(many(9)), (t) => t.id === "t7");
    expect(ids(preview.visible)).toEqual(["t0", "t1", "t2", "t3", "t4", "t7"]);
    expect(preview.hiddenCount).toBe(3);
  });

  it("keeps a session waiting on the user visible past the fold", () => {
    const tasks = many(9);
    tasks[8] = task({ id: "t8", awaiting_input: true });
    const preview = previewSessions(flat(tasks), noneActive);
    expect(ids(preview.visible)).toEqual(["t0", "t1", "t2", "t3", "t4", "t8"]);
    expect(preview.hiddenCount).toBe(3);
  });

  it("shows everything when only the focused row would remain folded", () => {
    const preview = previewSessions(flat(many(7)), (t) => t.id === "t6");
    expect(preview.visible).toHaveLength(7);
    expect(preview.hiddenCount).toBe(0);
  });

  it("keeps the delegators above a row kept past the fold", () => {
    const tasks = [
      ...many(6),
      task({ id: "lead" }),
      child("mid", "lead"),
      child("leaf", "mid", { awaiting_input: true }),
      task({ id: "tail" }),
    ];
    const preview = previewSessions(nested(tasks), noneActive);
    expect(ids(preview.visible)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "lead",
      "mid",
      "leaf",
    ]);
    expect(preview.hiddenCount).toBe(2);
  });

  it("keeps a collapsed row hiding a session that waits on the user", () => {
    const tasks = [
      ...many(6),
      task({ id: "lead" }),
      child("blocked", "lead", { awaiting_input: true }),
      task({ id: "tail" }),
    ];
    const rows = nested(tasks, { collapsed: new Set(["lead"]) });
    const preview = previewSessions(rows, noneActive);
    expect(ids(preview.visible)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "lead",
    ]);
    expect(preview.hiddenCount).toBe(2);
  });
});
