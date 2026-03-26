import { describe, expect, it } from "vitest";
import {
  selectTargetTaskRun,
  toTaskAttemptFromRun,
} from "../task-run-selection";
import type { TaskRunRecord } from "../../types";

const makeRun = (id: string, status: string): TaskRunRecord => ({
  id,
  task_id: "task-1",
  execution_mode: "local",
  status,
  run_reason: null,
  executor_action: null,
  executor_action_type: null,
  exit_code: null,
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
});

describe("selectTargetTaskRun", () => {
  it("returns null when runs are empty", () => {
    expect(selectTargetTaskRun([], undefined)).toBeNull();
  });

  it("prioritizes explicit selectedRunId", () => {
    const runs = [makeRun("a", "completed"), makeRun("b", "running")];
    expect(selectTargetTaskRun(runs, "a")?.id).toBe("a");
  });

  it("returns active run by default", () => {
    const runs = [makeRun("a", "completed"), makeRun("b", "running")];
    expect(selectTargetTaskRun(runs)?.id).toBe("b");
  });

  it("falls back to first run when no active run exists", () => {
    const runs = [makeRun("a", "failed"), makeRun("b", "completed")];
    expect(selectTargetTaskRun(runs)?.id).toBe("a");
  });
});

describe("toTaskAttemptFromRun", () => {
  it("maps known run status values", () => {
    const attempt = toTaskAttemptFromRun("task-1", makeRun("a", "running"));
    expect(attempt.status).toBe("running");
  });

  it("falls back unknown status to failed", () => {
    const attempt = toTaskAttemptFromRun("task-1", makeRun("a", "unknown"));
    expect(attempt.status).toBe("failed");
  });
});
