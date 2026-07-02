import { describe, expect, it } from "vitest";
import type { TaskRunRecord } from "../../types/api";
import {
  deriveSessionRunState,
  resolveCancelAction,
} from "../session-run-state";
import {
  type PendingSessionSubmission,
  createPendingSessionSubmission,
  finishPendingSessionSubmission,
  resolvePendingSessionSubmission,
} from "../session-task-state";

const makeRun = (overrides: Partial<TaskRunRecord> = {}): TaskRunRecord => ({
  id: "run-1",
  slug: null,
  task_id: "task-1",
  execution_mode: "local",
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

const makePending = (
  overrides: { runId?: string | null; finishedAt?: string | null } = {},
): PendingSessionSubmission => {
  let pending = createPendingSessionSubmission({
    scopeId: "scope-1",
    requestId: "req-1",
    prompt: "do the thing",
    createdAt: "2025-01-01T00:00:00.000Z",
    taskId: "task-1",
    taskSlug: "task-one",
  });
  if (overrides.runId) {
    pending = resolvePendingSessionSubmission(pending, {
      execution_id: "exec-1",
      task_run_id: overrides.runId,
      task_id: "task-1",
      project_id: "project-1",
      executor_session_id: "sess-1",
    });
  }
  if (overrides.finishedAt) {
    pending = finishPendingSessionSubmission(pending, overrides.finishedAt);
  }
  return pending;
};

describe("deriveSessionRunState", () => {
  it("treats a fresh submission with no run id yet as the create window", () => {
    const state = deriveSessionRunState({
      taskRuns: [],
      isTaskRunsLoading: false,
      pendingSubmission: makePending(),
      activeSessionHint: null,
    });
    expect(state.isRunning).toBe(true);
    expect(state.isInCreateWindow).toBe(true);
    expect(state.cancelTargetRunId).toBeNull();
  });

  it("reports the running run id as the cancel target", () => {
    const state = deriveSessionRunState({
      taskRuns: [makeRun({ id: "run-9", status: "running" })],
      isTaskRunsLoading: false,
      pendingSubmission: null,
      activeSessionHint: null,
    });
    expect(state.isRunning).toBe(true);
    expect(state.isInCreateWindow).toBe(false);
    expect(state.cancelTargetRunId).toBe("run-9");
  });

  it("targets the cancelable run, not a completed one", () => {
    const state = deriveSessionRunState({
      taskRuns: [
        makeRun({ id: "run-new", status: "running" }),
        makeRun({ id: "run-old", status: "completed" }),
      ],
      isTaskRunsLoading: false,
      pendingSubmission: null,
      activeSessionHint: null,
    });
    expect(state.cancelTargetRunId).toBe("run-new");
  });

  it("is idle when every run is terminal and the submission finished", () => {
    const state = deriveSessionRunState({
      taskRuns: [makeRun({ id: "run-1", status: "completed" })],
      isTaskRunsLoading: false,
      pendingSubmission: makePending({
        runId: "run-1",
        finishedAt: "2025-01-02T00:00:00.000Z",
      }),
      activeSessionHint: null,
    });
    expect(state.isRunning).toBe(false);
    expect(state.isInCreateWindow).toBe(false);
    expect(state.cancelTargetRunId).toBeNull();
  });

  it("uses the active-session hint only while the stream is loading", () => {
    const state = deriveSessionRunState({
      taskRuns: [],
      isTaskRunsLoading: true,
      pendingSubmission: null,
      activeSessionHint: "session-7",
    });
    expect(state.isRunning).toBe(true);
    expect(state.cancelTargetRunId).toBeNull();
  });

  it("lets the loaded stream win over a stale active-session hint", () => {
    // Regression: the task patch clearing active_session_id stalled, but the run
    // stream already shows the run completed, so the UI must read as idle.
    const state = deriveSessionRunState({
      taskRuns: [makeRun({ id: "run-1", status: "completed" })],
      isTaskRunsLoading: false,
      pendingSubmission: null,
      activeSessionHint: "session-stuck",
    });
    expect(state.isRunning).toBe(false);
  });

  it("hands the create window off to the stream once the run appears", () => {
    const state = deriveSessionRunState({
      taskRuns: [makeRun({ id: "run-1", status: "running" })],
      isTaskRunsLoading: false,
      pendingSubmission: makePending({ runId: "run-1" }),
      activeSessionHint: null,
    });
    expect(state.isInCreateWindow).toBe(false);
    expect(state.isRunning).toBe(true);
    expect(state.cancelTargetRunId).toBe("run-1");
  });
});

describe("resolveCancelAction", () => {
  it("cancels the real run when one is cancelable", () => {
    const action = resolveCancelAction(
      { cancelTargetRunId: "run-3", isInCreateWindow: false },
      makePending({ runId: "run-3" }),
      false,
    );
    expect(action).toEqual({ type: "cancel-run", runId: "run-3" });
  });

  it("aborts the in-flight create when no run exists yet", () => {
    const action = resolveCancelAction(
      { cancelTargetRunId: null, isInCreateWindow: true },
      makePending(),
      false,
    );
    expect(action).toEqual({ type: "abort-create", requestId: "req-1" });
  });

  it("does nothing when nothing is cancelable", () => {
    const action = resolveCancelAction(
      { cancelTargetRunId: null, isInCreateWindow: false },
      null,
      false,
    );
    expect(action).toEqual({ type: "none" });
  });

  it("does nothing while a cancel is already in progress", () => {
    const action = resolveCancelAction(
      { cancelTargetRunId: "run-3", isInCreateWindow: false },
      makePending({ runId: "run-3" }),
      true,
    );
    expect(action).toEqual({ type: "none" });
  });
});
