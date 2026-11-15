import { describe, expect, it } from "vitest";
import type { StoredTask } from "../types";
import { sessionSubline } from "./session-subline";

const base: StoredTask = {
  id: "t1",
  project_id: "p1",
  title: "Fix login",
  status: "in_progress",
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
  sort_order: 0,
};

const noProject = {
  isRunning: false,
  showProject: false,
  projectName: null,
  nestedUnderDelegator: false,
};

describe("sessionSubline", () => {
  it("shows the agent's note while a turn runs, even over a summary", () => {
    const task = { ...base, note: "running tests", last_summary: "fixed it" };
    expect(sessionSubline(task, { ...noProject, isRunning: true })).toEqual({
      kind: "note",
      text: "running tests",
    });
  });

  it("prefers the outcome of the last run once the session is idle", () => {
    const task = { ...base, note: "running tests", last_summary: "fixed it" };
    expect(sessionSubline(task, noProject)).toEqual({
      kind: "summary",
      text: "fixed it",
    });
  });

  it("falls back to the note when no run has finished yet", () => {
    const task = { ...base, note: "waiting on review" };
    expect(sessionSubline(task, noProject)).toEqual({
      kind: "note",
      text: "waiting on review",
    });
  });

  it("then shows provenance, then the project", () => {
    expect(
      sessionSubline({ ...base, forked_from_title: "Parent" }, noProject),
    ).toEqual({ kind: "forked", text: "Parent" });
    expect(
      sessionSubline({ ...base, delegated_from_title: "Lead" }, noProject),
    ).toEqual({ kind: "delegated", text: "Lead" });
    expect(
      sessionSubline(base, {
        ...noProject,
        showProject: true,
        projectName: "repo",
      }),
    ).toEqual({ kind: "project", text: "repo" });
    expect(sessionSubline(base, noProject)).toBeNull();
  });

  it("drops the delegator when the row already sits under it", () => {
    const delegated = { ...base, delegated_from_title: "Lead" };
    expect(
      sessionSubline(delegated, { ...noProject, nestedUnderDelegator: true }),
    ).toBeNull();
    expect(
      sessionSubline(
        { ...delegated, forked_from_title: "Parent" },
        { ...noProject, nestedUnderDelegator: true },
      ),
    ).toEqual({ kind: "forked", text: "Parent" });
  });
});
