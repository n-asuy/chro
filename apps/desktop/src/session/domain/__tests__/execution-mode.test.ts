import { describe, expect, it } from "vitest";
import { resolveUseWorktreeForRun } from "../execution-mode";
import type { TaskRunRecord } from "../../types";

const makeRun = (
  overrides?: Partial<TaskRunRecord>,
): TaskRunRecord => ({
  id: "run-1",
  task_id: "task-1",
  execution_mode: "local",
  status: "completed",
  run_reason: null,
  executor_action: null,
  executor_action_type: null,
  exit_code: 0,
  dropped: false,
  before_head_commit: null,
  after_head_commit: null,
  branch_name: null,
  target_branch: null,
  container_ref: null,
  workspace_path: null,
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

describe("resolveUseWorktreeForRun", () => {
  it("returns true when run metadata is incomplete", () => {
    const run = makeRun();
    expect(resolveUseWorktreeForRun(run, "/repo")).toBe(true);
  });

  it("returns false when execution path equals workspace path", () => {
    const run = makeRun({ container_ref: "/repo" });
    expect(resolveUseWorktreeForRun(run, "/repo/")).toBe(false);
  });

  it("returns false for macOS /private/var alias of same path", () => {
    const run = makeRun({
      container_ref: "/private/var/folders/k1/demo/repo",
    });
    expect(resolveUseWorktreeForRun(run, "/var/folders/k1/demo/repo")).toBe(
      false,
    );
  });

  it("returns true when execution path differs from workspace path", () => {
    const run = makeRun({
      container_ref: "/tmp/worktrees/ch/run-1",
    });
    expect(resolveUseWorktreeForRun(run, "/repo")).toBe(true);
  });

  it("returns true when worktree is marked deleted", () => {
    const run = makeRun({
      container_ref: "/repo",
      worktree_deleted: true,
    });
    expect(resolveUseWorktreeForRun(run, "/repo")).toBe(true);
  });
});
