import { afterEach, describe, expect, it, vi } from "vitest";
import { taskApi } from "./task-api";

const respond = (status: number, body = "") =>
  vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(status === 204 ? null : body, { status }));

afterEach(() => vi.restoreAllMocks());

describe("taskApi.cancel", () => {
  it("treats a session with no run to stop as already stopped", async () => {
    respond(404, "no active run");
    await expect(taskApi.cancel("task-1")).resolves.toBeUndefined();
  });

  it("reports a stop that failed", async () => {
    respond(500, "could not stop");
    await expect(taskApi.cancel("task-1")).rejects.toThrow("could not stop");
  });
});

describe("taskApi.remove", () => {
  it("deletes the session", async () => {
    const fetch = respond(204);
    await taskApi.remove("task 1");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/rpc/tasks/task%201"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
