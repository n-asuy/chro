import { describe, expect, it, vi } from "vitest";
import type { StoredTask } from "../types";
import { type ArchiveTaskApi, archiveTask } from "./use-archived-sessions";

const ARCHIVED_STATUS = "cancelled";

const makeTask = (overrides: Partial<StoredTask> = {}): StoredTask =>
  ({
    id: "task-1",
    active_session_id: null,
    ...overrides,
  }) as StoredTask;

const makeApi = (
  cancel: ArchiveTaskApi["cancel"] = vi.fn().mockResolvedValue(undefined),
) => {
  const updateStatus = vi.fn().mockResolvedValue(undefined);
  return {
    api: { cancel, updateStatus } satisfies ArchiveTaskApi,
    cancel,
    updateStatus,
  };
};

describe("archiveTask", () => {
  it("archives an idle session without cancelling anything", async () => {
    const { api, cancel, updateStatus } = makeApi();
    await archiveTask(makeTask({ active_session_id: null }), api);
    expect(cancel).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith("task-1", ARCHIVED_STATUS);
  });

  it("cancels the run first when the session still reads as running, then archives", async () => {
    // Regression: a session stuck "running" (active_session_id never cleared,
    // e.g. an orphaned run) must be archivable. Cancel settles the run, then we
    // archive.
    const calls: string[] = [];
    const cancel = vi.fn().mockImplementation(async () => {
      calls.push("cancel");
    });
    const updateStatus = vi.fn().mockImplementation(async () => {
      calls.push("updateStatus");
    });
    await archiveTask(makeTask({ active_session_id: "sess-1" }), {
      cancel,
      updateStatus,
    });
    expect(cancel).toHaveBeenCalledWith("task-1");
    expect(updateStatus).toHaveBeenCalledWith("task-1", ARCHIVED_STATUS);
    expect(calls).toEqual(["cancel", "updateStatus"]);
  });

  it("leaves the session in the list when its run cannot be stopped", async () => {
    // Archiving hides the session; hiding one whose agent is still running
    // would leave it working out of sight. "Nothing to stop" is not a failure
    // (taskApi.cancel resolves for it), so a rejection here is a real one.
    const cancel = vi.fn().mockRejectedValue(new Error("stop failed"));
    const { api, updateStatus } = makeApi(cancel);
    await expect(
      archiveTask(makeTask({ active_session_id: "sess-1" }), {
        ...api,
        cancel,
      }),
    ).rejects.toThrow("stop failed");
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
