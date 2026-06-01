import type { TaskRunRecord } from "@/session/types";
import type { TabKind } from "@/workspace-layout/types";
import { describe, expect, it } from "vitest";
import { resolveScopeTaskRunId } from "../workspace-scope";

const WORKSPACE = "/repo";

const makeRun = (overrides?: Partial<TaskRunRecord>): TaskRunRecord => ({
  id: "run-1",
  task_id: "task-1",
  execution_mode: "worktree",
  status: "running",
  run_reason: null,
  executor_action: null,
  executor_action_type: null,
  exit_code: null,
  dropped: false,
  before_head_commit: null,
  after_head_commit: null,
  branch_name: null,
  target_branch: null,
  container_ref: "/tmp/worktrees/run-1",
  workspace_path: WORKSPACE,
  executor_label: null,
  resume_session_id: null,
  worktree_deleted: false,
  executor_job_id: null,
  s3_prefix: null,
  logs_uri: null,
  summary_uri: null,
  diffs_prefix: null,
  logs_retrieval_failed: false,
  started_at: null,
  completed_at: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

describe("resolveScopeTaskRunId", () => {
  it("returns null when no tab is focused", () => {
    expect(resolveScopeTaskRunId(null, [], WORKSPACE)).toBeNull();
  });

  it("returns null for a new session (no taskId)", () => {
    const kind: TabKind = { type: "session" };
    expect(resolveScopeTaskRunId(kind, [makeRun()], WORKSPACE)).toBeNull();
  });

  it("returns the active worktree run for a session tab", () => {
    const kind: TabKind = { type: "session", taskId: "task-1" };
    expect(resolveScopeTaskRunId(kind, [makeRun()], WORKSPACE)).toBe("run-1");
  });

  it("selects the run matching the tab's runId", () => {
    const kind: TabKind = {
      type: "session",
      taskId: "task-1",
      runId: "run-2",
    };
    const runs = [
      makeRun({ id: "run-1" }),
      makeRun({ id: "run-2", status: "completed" }),
    ];
    expect(resolveScopeTaskRunId(kind, runs, WORKSPACE)).toBe("run-2");
  });

  it("falls back to the project root for a local run", () => {
    const kind: TabKind = { type: "session", taskId: "task-1" };
    // container_ref equals the workspace path → local execution.
    const local = makeRun({ container_ref: WORKSPACE });
    expect(resolveScopeTaskRunId(kind, [local], WORKSPACE)).toBeNull();
  });

  it("returns null for a session tab with no runs yet", () => {
    const kind: TabKind = { type: "session", taskId: "task-1" };
    expect(resolveScopeTaskRunId(kind, [], WORKSPACE)).toBeNull();
  });

  it("uses the run id directly for a worktree file tab", () => {
    const kind: TabKind = {
      type: "file",
      path: "/src/main.ts",
      taskRunId: "run-9",
    };
    expect(resolveScopeTaskRunId(kind, [], WORKSPACE)).toBe("run-9");
  });

  it("returns null for a project file tab (no taskRunId)", () => {
    const kind: TabKind = { type: "file", path: "/src/main.ts" };
    expect(resolveScopeTaskRunId(kind, [], WORKSPACE)).toBeNull();
  });

  it("uses the run id for a diff tab", () => {
    const kind: TabKind = { type: "diff", runId: "run-7" };
    expect(resolveScopeTaskRunId(kind, [], WORKSPACE)).toBe("run-7");
  });

  it("returns null for non-session surfaces (terminal, settings)", () => {
    expect(
      resolveScopeTaskRunId({ type: "terminal" }, [], WORKSPACE),
    ).toBeNull();
    expect(
      resolveScopeTaskRunId({ type: "settings" }, [], WORKSPACE),
    ).toBeNull();
  });
});
