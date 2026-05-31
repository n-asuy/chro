import { afterEach, describe, expect, it } from "vitest";
import type { StartClaudeResponse } from "../types/api";
import { usePendingSessionSubmissionsStore } from "./pending-session-submissions-store";

const resetStore = () => {
  usePendingSessionSubmissionsStore.setState({ submissionsByProjectId: {} });
};

describe("pending session submissions store", () => {
  afterEach(() => {
    resetStore();
  });

  it("stores new pending submissions under their project", () => {
    const pending = usePendingSessionSubmissionsStore
      .getState()
      .beginPendingSubmission("project-1", {
        scopeId: "scope-1",
        requestId: "req-1",
        prompt: "New task prompt",
        createdAt: "2025-01-01T00:00:00.000Z",
        taskId: null,
        taskSlug: null,
      });

    expect(pending.tempTaskId).toBe("optimistic-task-req-1");
    expect(
      usePendingSessionSubmissionsStore.getState().submissionsByProjectId[
        "project-1"
      ]?.["req-1"],
    ).toBe(pending);
  });

  it("resolves and clears project-scoped submissions", () => {
    const store = usePendingSessionSubmissionsStore.getState();
    store.beginPendingSubmission("project-1", {
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

    usePendingSessionSubmissionsStore
      .getState()
      .resolvePendingSubmission("project-1", "req-1", response);

    expect(
      usePendingSessionSubmissionsStore.getState().submissionsByProjectId[
        "project-1"
      ]?.["req-1"],
    ).toMatchObject({
      taskId: "task-1",
      taskSlug: "task-one",
      runId: "run-1",
    });

    usePendingSessionSubmissionsStore
      .getState()
      .clearPendingSubmission("project-1", "req-1");

    expect(
      usePendingSessionSubmissionsStore.getState().submissionsByProjectId[
        "project-1"
      ],
    ).toBeUndefined();
  });

  it("marks a pending submission finished without clearing it", () => {
    const store = usePendingSessionSubmissionsStore.getState();
    store.beginPendingSubmission("project-1", {
      scopeId: "scope-1",
      requestId: "req-1",
      prompt: "New task prompt",
      createdAt: "2025-01-01T00:00:00.000Z",
      taskId: null,
      taskSlug: null,
    });

    store.finishPendingSubmission(
      "project-1",
      "req-1",
      "2025-01-01T00:00:02.000Z",
    );

    expect(
      usePendingSessionSubmissionsStore.getState().submissionsByProjectId[
        "project-1"
      ]?.["req-1"],
    ).toMatchObject({
      requestId: "req-1",
      finishedAt: "2025-01-01T00:00:02.000Z",
    });
  });
});
