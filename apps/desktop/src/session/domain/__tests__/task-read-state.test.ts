import { describe, expect, it } from "vitest";
import type { StoredTask } from "../../types";
import { deriveTaskStatusDot } from "../task-read-state";

const makeTask = (overrides?: Partial<StoredTask>): StoredTask => ({
  id: "task-1",
  slug: "task-one",
  project_id: "project-1",
  title: "Existing task",
  description: null,
  status: "completed",
  branch: null,
  active_session_id: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  sort_order: 10,
  ...overrides,
});

describe("deriveTaskStatusDot", () => {
  it("returns no dot for a running task even when unviewed", () => {
    const task = makeTask({
      status: "in_progress",
      active_session_id: "run-1",
    });
    expect(deriveTaskStatusDot(task, null)).toBeNull();
  });

  it("returns no dot for non-terminal states", () => {
    expect(
      deriveTaskStatusDot(makeTask({ status: "pending" }), null),
    ).toBeNull();
    expect(
      deriveTaskStatusDot(makeTask({ status: "in_progress" }), null),
    ).toBeNull();
    expect(
      deriveTaskStatusDot(makeTask({ status: "cancelled" }), null),
    ).toBeNull();
  });

  it("flags a completed-but-unread task blue", () => {
    const task = makeTask({ status: "completed" });
    expect(deriveTaskStatusDot(task, null)).toBe("completed");
  });

  it("flags a failed-but-unread task red", () => {
    const task = makeTask({ status: "failed" });
    expect(deriveTaskStatusDot(task, null)).toBe("failed");
  });

  it("clears the dot once viewed at or after the last update", () => {
    const task = makeTask({
      status: "completed",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    expect(deriveTaskStatusDot(task, "2025-01-01T00:00:00.000Z")).toBeNull();
    expect(deriveTaskStatusDot(task, "2025-01-02T00:00:00.000Z")).toBeNull();
  });

  it("re-flags when the task updates after the last view", () => {
    const task = makeTask({
      status: "completed",
      updated_at: "2025-01-03T00:00:00.000Z",
    });
    expect(deriveTaskStatusDot(task, "2025-01-01T00:00:00.000Z")).toBe(
      "completed",
    );
  });

  it("treats an unparseable view timestamp as unread", () => {
    const task = makeTask({ status: "failed" });
    expect(deriveTaskStatusDot(task, "not-a-date")).toBe("failed");
  });
});
