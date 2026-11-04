import { describe, expect, it } from "vitest";
import type { StoredTask } from "../types";
import {
  type TaskContextRef,
  relatedSessionGroup,
  runningDelegationCounts,
  sessionRelations,
} from "./session-relations";

const ME = "me";

const task = (id: string, fields: Partial<StoredTask> = {}): StoredTask => ({
  id,
  project_id: "p1",
  title: `title of ${id}`,
  status: "in_progress",
  created_at: "2026-10-31T00:00:00Z",
  updated_at: "2026-10-31T00:00:00Z",
  sort_order: 0,
  ...fields,
});

let seq = 0;
const ref = (fields: Partial<TaskContextRef>): TaskContextRef => ({
  id: `ref-${++seq}`,
  task_id: ME,
  kind: "session",
  mode: "link",
  sort_order: 0,
  created_at: "2026-10-31T00:00:00Z",
  updated_at: "2026-10-31T00:00:00Z",
  ...fields,
});

const byId = (...tasks: StoredTask[]) =>
  Object.fromEntries(tasks.map((t) => [t.id, t]));

describe("sessionRelations", () => {
  it("names the counterpart with its live title, never the incoming row's label", () => {
    // A child's delegate edge snapshots the DELEGATING task's title. Read from
    // the delegating side, that label is our own name, not the child's.
    const incoming = [
      ref({
        task_id: "child",
        target_task_id: ME,
        kind: "delegate",
        label: "my own title",
      }),
    ];
    const rows = sessionRelations(
      ME,
      [],
      incoming,
      byId(task("child", { title: "Schema migration" })),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        relation: "delegated_to",
        taskId: "child",
        title: "Schema migration",
      }),
    ]);
  });

  it("folds a child's delegate edge and our handoff for it into one row", () => {
    const outgoing = [
      ref({
        kind: "handoff",
        target_task_id: "child",
        label: "Schema migration",
      }),
    ];
    const incoming = [
      ref({ task_id: "child", target_task_id: ME, kind: "delegate" }),
    ];
    const rows = sessionRelations(
      ME,
      outgoing,
      incoming,
      byId(task("child", { status: "completed" })),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      relation: "delegated_to",
      taskId: "child",
      state: "done",
    });
  });

  it("shows the delegating task once on the delegated side", () => {
    const outgoing = [
      ref({
        kind: "delegate",
        target_task_id: "lead",
        label: "Billing revamp",
      }),
    ];
    const incoming = [
      ref({ task_id: "lead", target_task_id: ME, kind: "handoff" }),
    ];
    const rows = sessionRelations(ME, outgoing, incoming, {});
    expect(rows).toEqual([
      expect.objectContaining({
        relation: "delegated_from",
        taskId: "lead",
        title: "Billing revamp",
        state: null,
      }),
    ]);
  });

  it("falls back to the outgoing snapshot, then a short id, when the counterpart is gone", () => {
    const outgoing = [
      ref({
        kind: "handoff",
        target_task_id: "gone-child",
        label: "Old title",
      }),
      ref({
        kind: "session",
        target_task_id: "1234abcd-ffff-0000-0000-000000000000",
      }),
    ];
    const rows = sessionRelations(ME, outgoing, [], {});
    expect(rows.map((row) => row.title)).toEqual(["Old title", "1234abcd"]);
  });

  it("derives delegation state from the live task, running first", () => {
    const incoming = [
      ref({ task_id: "done", target_task_id: ME, kind: "delegate" }),
      ref({ task_id: "failed", target_task_id: ME, kind: "delegate" }),
      ref({ task_id: "running", target_task_id: ME, kind: "delegate" }),
      ref({ task_id: "queued", target_task_id: ME, kind: "delegate" }),
    ];
    const tasks = byId(
      task("done", { status: "completed" }),
      task("failed", { status: "failed" }),
      task("running", { active_session_id: "s1", status: "completed" }),
      task("queued"),
    );
    const rows = sessionRelations(ME, [], incoming, tasks);
    expect(rows.map((row) => [row.taskId, row.state])).toEqual([
      ["running", "running"],
      ["done", "done"],
      ["failed", "failed"],
      ["queued", null],
    ]);
  });

  it("treats a handed-off child as done even after it was deleted", () => {
    const outgoing = [
      ref({ kind: "handoff", target_task_id: "gone", label: "x" }),
    ];
    expect(sessionRelations(ME, outgoing, [], {})[0]).toMatchObject({
      state: "done",
    });
  });

  it("keeps the strongest relation per counterpart and orders by relation", () => {
    const outgoing = [
      ref({ kind: "file", path: "docs/billing.md" }),
      ref({ kind: "session", target_task_id: "peer" }),
      ref({ kind: "session", target_task_id: "child" }),
      ref({ kind: "fork", target_task_id: "origin" }),
      ref({ kind: "delegate", target_task_id: "lead" }),
    ];
    const incoming = [
      ref({ task_id: "reader", target_task_id: ME, kind: "session" }),
      ref({ task_id: "child", target_task_id: ME, kind: "delegate" }),
      ref({ task_id: "copy", target_task_id: ME, kind: "fork" }),
    ];
    const rows = sessionRelations(ME, outgoing, incoming, {});
    expect(rows.map((row) => [row.relation, row.taskId ?? row.path])).toEqual([
      ["delegated_to", "child"],
      ["delegated_from", "lead"],
      ["continued_from", "origin"],
      ["continued_in", "copy"],
      ["uses", "peer"],
      ["uses", "docs/billing.md"],
      ["referenced_by", "reader"],
    ]);
  });

  it("lists a path once and marks directories", () => {
    const outgoing = [
      ref({ kind: "directory", path: "src/" }),
      ref({ kind: "file", path: "README.md" }),
      ref({
        kind: "file",
        path: "README.md",
        task_session_id: "other-session",
      }),
    ];
    expect(sessionRelations(ME, outgoing, [], {})).toEqual([
      expect.objectContaining({
        relation: "uses",
        path: "src/",
        isDirectory: true,
        title: "src",
      }),
      expect.objectContaining({
        relation: "uses",
        path: "README.md",
        isDirectory: false,
        title: "README.md",
      }),
    ]);
  });

  it("skips edges that point back at the session itself or at nothing", () => {
    const outgoing = [
      ref({ kind: "session", target_task_id: ME }),
      ref({ kind: "session" }),
    ];
    expect(sessionRelations(ME, outgoing, [], {})).toEqual([]);
  });
});

describe("runningDelegationCounts", () => {
  it("counts each task's delegated sessions that are running now", () => {
    const counts = runningDelegationCounts([
      task("lead"),
      task("a", { delegated_from_id: "lead", active_session_id: "s1" }),
      task("b", { delegated_from_id: "lead", active_session_id: "s2" }),
      task("c", { delegated_from_id: "lead", status: "completed" }),
      task("d", { delegated_from_id: "other", active_session_id: "s3" }),
    ]);
    expect(counts.get("lead")).toBe(2);
    expect(counts.get("other")).toBe(1);
    expect(counts.has("a")).toBe(false);
  });
});

describe("relatedSessionGroup", () => {
  it("holds the session and every session it relates to, in either direction", () => {
    const outgoing = [
      ref({ kind: "handoff", target_task_id: "child" }),
      ref({ kind: "session", target_task_id: "used" }),
      ref({ kind: "file", path: "README.md" }),
    ];
    const incoming = [ref({ kind: "session", task_id: "reader" })];
    expect(relatedSessionGroup(ME, outgoing, incoming)).toEqual(
      new Set([ME, "child", "used", "reader"]),
    );
  });

  it("is empty when the session relates to no other session", () => {
    const outgoing = [
      ref({ kind: "file", path: "README.md" }),
      ref({ kind: "session", target_task_id: ME }),
    ];
    expect(relatedSessionGroup(ME, outgoing, []).size).toBe(0);
  });
});
