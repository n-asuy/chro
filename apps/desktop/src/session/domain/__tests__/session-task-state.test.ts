import { describe, expect, it } from "vitest";
import type { StartClaudeResponse } from "../../types/api";
import type { StoredTask } from "../../types";
import {
  applyPendingSubmissionToTasks,
  createPendingSessionSubmission,
  derivePendingTaskTitle,
  resolveActiveTaskId,
  resolvePendingSessionSubmission,
  resolveStreamTaskId,
} from "../session-task-state";

const makeTask = (overrides?: Partial<StoredTask>): StoredTask => ({
  id: "task-1",
  slug: "task-one",
  project_id: "project-1",
  title: "Existing task",
  description: null,
  status: "pending",
  branch: null,
  active_session_id: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  sort_order: 10,
  ...overrides,
});

describe("derivePendingTaskTitle", () => {
  it("uses the first non-empty line", () => {
    expect(
      derivePendingTaskTitle("\n  First line title  \nSecond line body"),
    ).toBe("First line title");
  });
});

describe("pending submission lifecycle", () => {
  it("creates a temp task and run for new sessions", () => {
    const pending = createPendingSessionSubmission({
      requestId: "req-1",
      prompt: "New task prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: null,
      taskSlug: null,
    });

    expect(pending.tempTaskId).toBe("optimistic-task-req-1");
    expect(pending.tempRunId).toBe("optimistic-run-req-1");
  });

  it("resolves temp ids from the server response", () => {
    const pending = createPendingSessionSubmission({
      requestId: "req-1",
      prompt: "New task prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: null,
      taskSlug: null,
    });
    const response: StartClaudeResponse = {
      execution_id: "exec-1",
      task_run_id: "run-1",
      task_id: "task-1",
      project_id: "project-1",
      executor_session_id: "executor-1",
      task_slug: "task-one",
      task_run_slug: "run-one",
    };

    expect(resolvePendingSessionSubmission(pending, response)).toMatchObject({
      taskId: "task-1",
      taskSlug: "task-one",
      tempTaskId: null,
      runId: "run-1",
      tempRunId: "optimistic-run-req-1",
    });
  });
});

describe("applyPendingSubmissionToTasks", () => {
  it("prepends a synthetic task for a new pending session", () => {
    const pending = createPendingSessionSubmission({
      requestId: "req-1",
      prompt: "New task prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: null,
      taskSlug: null,
    });

    const result = applyPendingSubmissionToTasks([], pending, "project-1");
    expect(result[0]).toMatchObject({
      id: "optimistic-task-req-1",
      title: "New task prompt",
      active_session_id: "optimistic-run-req-1",
    });
  });

  it("overlays active state on existing tasks", () => {
    const pending = createPendingSessionSubmission({
      requestId: "req-1",
      prompt: "Follow up prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: "task-1",
      taskSlug: "task-one",
    });

    const result = applyPendingSubmissionToTasks([makeTask()], pending, "project-1");
    expect(result[0]).toMatchObject({
      id: "task-1",
      active_session_id: "optimistic-run-req-1",
    });
  });
});

describe("resolveActiveTaskId", () => {
  it("resolves by slug from displayed tasks", () => {
    const tasks = [makeTask()];
    expect(resolveActiveTaskId("task-one", tasks)).toBe("task-1");
  });

  it("resolves by id from displayed tasks", () => {
    const tasks = [makeTask()];
    expect(resolveActiveTaskId("task-1", tasks)).toBe("task-1");
  });

  it("returns null when no route slug is present", () => {
    expect(resolveActiveTaskId(null, [makeTask()])).toBeNull();
  });

  it("returns null when route slug matches no task", () => {
    expect(resolveActiveTaskId("unknown", [makeTask()])).toBeNull();
  });
});

describe("resolveStreamTaskId", () => {
  it("uses the streamed task id when present", () => {
    expect(
      resolveStreamTaskId("task-1", { "task-1": makeTask() }, null),
    ).toBe("task-1");
  });

  it("uses the resolved pending task id before the task stream catches up", () => {
    const pending = resolvePendingSessionSubmission(
      createPendingSessionSubmission({
        requestId: "req-1",
        prompt: "New task prompt",
        createdAt: "2025-01-01T00:00:00.000Z",
        taskId: null,
        taskSlug: null,
      }),
      {
        execution_id: "exec-1",
        task_run_id: "run-1",
        task_id: "task-1",
        project_id: "project-1",
        executor_session_id: "executor-1",
        task_slug: "task-one",
        task_run_slug: "run-one",
      },
    );

    expect(resolveStreamTaskId("task-1", {}, pending)).toBe("task-1");
  });
});
