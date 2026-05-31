import { describe, expect, it } from "vitest";
import type { StoredTask } from "../../types";
import type { StartClaudeResponse } from "../../types/api";
import {
  applyPendingSubmissionToTasks,
  applyPendingSubmissionsToTasks,
  createPendingSessionSubmission,
  derivePendingTaskTitle,
  finishPendingSessionSubmission,
  isPendingSubmissionForTaskScope,
  isPendingSubmissionSettledByTask,
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
      scopeId: "scope-1",
      requestId: "req-1",
      prompt: "New task prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: null,
      taskSlug: null,
    });

    expect(pending.tempTaskId).toBe("optimistic-task-req-1");
    expect(pending.tempRunId).toBe("optimistic-run-req-1");
    expect(pending.startedWithoutTask).toBe(true);
    expect(pending.finishedAt).toBeNull();
  });

  it("resolves temp ids from the server response", () => {
    const pending = createPendingSessionSubmission({
      scopeId: "scope-1",
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
      startedWithoutTask: true,
    });
  });
});

describe("applyPendingSubmissionToTasks", () => {
  it("prepends a synthetic task for a new pending session", () => {
    const pending = createPendingSessionSubmission({
      scopeId: "scope-1",
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
      scopeId: "scope-1",
      requestId: "req-1",
      prompt: "Follow up prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: "task-1",
      taskSlug: "task-one",
    });

    const result = applyPendingSubmissionToTasks(
      [makeTask()],
      pending,
      "project-1",
    );
    expect(result[0]).toMatchObject({
      id: "task-1",
      active_session_id: "optimistic-run-req-1",
    });
  });

  it("keeps a finished pending task visible without an active session", () => {
    const pending = finishPendingSessionSubmission(
      resolvePendingSessionSubmission(
        createPendingSessionSubmission({
          scopeId: "scope-1",
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
      ),
      "2025-01-01T00:00:02.000Z",
    );

    const result = applyPendingSubmissionToTasks([], pending, "project-1");
    expect(result[0]).toMatchObject({
      id: "task-1",
      status: "completed",
      active_session_id: null,
      updated_at: "2025-01-01T00:00:02.000Z",
    });
  });
});

describe("applyPendingSubmissionsToTasks", () => {
  it("keeps pending active state attached to each task instead of a single global task", () => {
    const pendingA = createPendingSessionSubmission({
      scopeId: "scope-1",
      requestId: "req-1",
      prompt: "Follow up A",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: "task-1",
      taskSlug: "task-one",
    });
    const pendingB = createPendingSessionSubmission({
      scopeId: "scope-1",
      requestId: "req-2",
      prompt: "Follow up B",
      createdAt: "2025-01-01T00:00:01.000Z",
      taskId: "task-2",
      taskSlug: "task-two",
    });

    const result = applyPendingSubmissionsToTasks(
      [
        makeTask(),
        makeTask({
          id: "task-2",
          slug: "task-two",
          title: "Second task",
        }),
      ],
      [pendingA, pendingB],
      "project-1",
    );

    expect(result.find((task) => task.id === "task-1")).toMatchObject({
      active_session_id: pendingA.tempRunId,
    });
    expect(result.find((task) => task.id === "task-2")).toMatchObject({
      active_session_id: pendingB.tempRunId,
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
    expect(resolveStreamTaskId("task-1", { "task-1": makeTask() }, null)).toBe(
      "task-1",
    );
  });

  it("uses the resolved pending task id before the task stream catches up", () => {
    const pending = resolvePendingSessionSubmission(
      createPendingSessionSubmission({
        scopeId: "scope-1",
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

describe("isPendingSubmissionForTaskScope", () => {
  it("matches a pending existing task only in that task scope", () => {
    const pending = createPendingSessionSubmission({
      scopeId: "scope-1",
      requestId: "req-1",
      prompt: "Follow up prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: "task-1",
      taskSlug: "task-one",
    });

    expect(isPendingSubmissionForTaskScope(pending, "task-1", "task-1")).toBe(
      true,
    );
    expect(isPendingSubmissionForTaskScope(pending, "task-2", "task-2")).toBe(
      false,
    );
  });

  it("matches a pending new task only before it has a concrete stream task", () => {
    const pending = createPendingSessionSubmission({
      scopeId: "scope-1",
      requestId: "req-1",
      prompt: "New task prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: null,
      taskSlug: null,
    });

    expect(isPendingSubmissionForTaskScope(pending, null, null)).toBe(true);
    expect(
      isPendingSubmissionForTaskScope(pending, pending.tempTaskId, null),
    ).toBe(true);
    expect(isPendingSubmissionForTaskScope(pending, "task-2", "task-2")).toBe(
      false,
    );
  });

  it("does not match a pending new task from another session scope", () => {
    const pending = createPendingSessionSubmission({
      scopeId: "scope-1",
      requestId: "req-1",
      prompt: "New task prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: null,
      taskSlug: null,
    });

    expect(
      isPendingSubmissionForTaskScope(pending, null, null, "scope-1"),
    ).toBe(true);
    expect(
      isPendingSubmissionForTaskScope(pending, null, null, "scope-2"),
    ).toBe(false);
  });

  it("keeps a resolved new-task submission scoped while route state catches up", () => {
    const pending = resolvePendingSessionSubmission(
      createPendingSessionSubmission({
        scopeId: "scope-1",
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

    expect(isPendingSubmissionForTaskScope(pending, null, null)).toBe(true);
  });
});

describe("isPendingSubmissionSettledByTask", () => {
  it("settles a resolved pending submission after the task clears active_session_id", () => {
    const pending = resolvePendingSessionSubmission(
      createPendingSessionSubmission({
        scopeId: "scope-1",
        requestId: "req-1",
        prompt: "Follow up prompt",
        createdAt: "2025-01-01T00:00:00.000Z",
        taskId: "task-1",
        taskSlug: "task-one",
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

    expect(
      isPendingSubmissionSettledByTask(
        pending,
        makeTask({
          active_session_id: null,
          updated_at: "2025-01-01T00:00:01.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("keeps pending while the streamed task is still older or active", () => {
    const pending = resolvePendingSessionSubmission(
      createPendingSessionSubmission({
        scopeId: "scope-1",
        requestId: "req-1",
        prompt: "Follow up prompt",
        createdAt: "2025-01-01T00:00:00.000Z",
        taskId: "task-1",
        taskSlug: "task-one",
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

    expect(
      isPendingSubmissionSettledByTask(
        pending,
        makeTask({
          active_session_id: null,
          updated_at: "2024-12-31T23:59:59.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      isPendingSubmissionSettledByTask(
        pending,
        makeTask({
          active_session_id: "session-1",
          updated_at: "2025-01-01T00:00:01.000Z",
        }),
      ),
    ).toBe(false);
  });
});
