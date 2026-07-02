import { describe, expect, it } from "vitest";
import type { StoredTask } from "../../types";
import {
  applyPendingSubmissionsToTasks,
  createPendingSessionSubmission,
  finishPendingSessionSubmission,
  isPendingSubmissionSettledByTask,
  resolvePendingSessionSubmission,
} from "../session-task-state";

const PROJECT = "project-1";
const REAL_TASK = "real-task-1";

/**
 * Build the optimistic submission for a brand new session that has been
 * accepted by the backend (run id assigned) and then finished.
 */
function finishedNewSessionSubmission() {
  let pending = createPendingSessionSubmission({
    scopeId: "scope-1",
    requestId: "req-1",
    prompt: "say hello",
    createdAt: "2025-01-01T00:00:00.000Z",
    taskId: null,
    taskSlug: null,
  });
  pending = resolvePendingSessionSubmission(pending, {
    execution_id: "exec-1",
    task_run_id: "run-1",
    task_id: REAL_TASK,
    project_id: PROJECT,
    executor_session_id: "sess-1",
  });
  return finishPendingSessionSubmission(pending, "2025-01-01T00:00:05.000Z");
}

const byId = (tasks: StoredTask[]): Record<string, StoredTask> =>
  Object.fromEntries(tasks.map((task) => [task.id, task]));

/**
 * Regression guard for the "new session vanishes from the sidebar after the
 * assistant replies, reappears on reload" bug. The cause was running the
 * pending-settlement check against tasks that already had the optimistic
 * overlay applied: a finished pending then settled against ITS OWN synthesized
 * row and cleared itself before the real task had reached the raw stream,
 * leaving nothing to show. Settlement must be evaluated against the RAW stream.
 */
describe("pending settlement must use the raw stream, not the optimistic overlay", () => {
  it("does NOT settle a finished pending while the real task is absent from the raw stream", () => {
    const pending = finishedNewSessionSubmission();
    const rawTasks: StoredTask[] = []; // real task not delivered to the stream yet

    expect(
      isPendingSubmissionSettledByTask(
        pending,
        byId(rawTasks)[REAL_TASK] ?? null,
      ),
    ).toBe(false);

    // The optimistic row therefore survives until the real task arrives.
    const displayed = applyPendingSubmissionsToTasks(
      rawTasks,
      [pending],
      PROJECT,
    );
    expect(displayed.map((task) => task.id)).toContain(REAL_TASK);
  });

  it("would self-settle if fed the optimistic overlay (the bug we must avoid)", () => {
    const pending = finishedNewSessionSubmission();
    const rawTasks: StoredTask[] = [];

    // Tasks with the overlay applied synthesize a finished row for REAL_TASK,
    // which spuriously satisfies the settlement check. This is exactly why the
    // settlement input must be the raw stream.
    const overlaid = applyPendingSubmissionsToTasks(
      rawTasks,
      [pending],
      PROJECT,
    );
    expect(
      isPendingSubmissionSettledByTask(
        pending,
        byId(overlaid)[REAL_TASK] ?? null,
      ),
    ).toBe(true);
  });

  it("settles and hands off to the real row once the real task is finished in the raw stream", () => {
    const pending = finishedNewSessionSubmission();
    const rawTasks: StoredTask[] = [
      {
        id: REAL_TASK,
        slug: "real-slug",
        project_id: PROJECT,
        title: "Real task",
        description: null,
        status: "completed",
        branch: null,
        active_session_id: null,
        created_at: "2025-01-01T00:00:01.000Z",
        updated_at: "2025-01-01T00:00:06.000Z",
        sort_order: 5,
      },
    ];

    expect(
      isPendingSubmissionSettledByTask(
        pending,
        byId(rawTasks)[REAL_TASK] ?? null,
      ),
    ).toBe(true);

    // After the pending is cleared, the real row keeps the session visible.
    const displayed = applyPendingSubmissionsToTasks(rawTasks, [], PROJECT);
    expect(displayed.map((task) => task.id)).toContain(REAL_TASK);
  });
});
