import { describe, expect, it } from "vitest";
import type { StoredTask } from "../types";
import { applyTaskTitleOverridesToTasksById } from "./task-title-overrides-store";

const makeTask = (overrides?: Partial<StoredTask>): StoredTask => ({
  id: "task-1",
  slug: "task-one",
  project_id: "project-1",
  title: "Original title",
  description: null,
  status: "pending",
  branch: null,
  active_session_id: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  sort_order: 0,
  ...overrides,
});

describe("applyTaskTitleOverridesToTasksById", () => {
  it("applies an optimistic title without mutating the streamed task", () => {
    const task = makeTask();
    const result = applyTaskTitleOverridesToTasksById(
      { [task.id]: task },
      { [task.id]: "Renamed session" },
    );

    expect(result[task.id]?.title).toBe("Renamed session");
    expect(task.title).toBe("Original title");
  });

  it("returns the original map when overrides do not affect streamed tasks", () => {
    const task = makeTask();
    const tasksById = { [task.id]: task };

    expect(
      applyTaskTitleOverridesToTasksById(tasksById, {
        "missing-task": "Ignored",
      }),
    ).toBe(tasksById);
  });
});
