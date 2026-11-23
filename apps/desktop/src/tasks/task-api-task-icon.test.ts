import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopFetch = vi.fn();
vi.mock("@/lib/backend-client", () => ({
  desktopFetch: (...args: unknown[]) => desktopFetch(...args),
}));

import { taskApi } from "./task-api";

describe("session icon", () => {
  beforeEach(() => desktopFetch.mockReset());

  it("posts the chosen icon and reads back the stored session", async () => {
    desktopFetch.mockResolvedValueOnce({ task: { id: "t1", icon: "rocket" } });

    const task = await taskApi.setTaskIcon("t1", "rocket");

    expect(desktopFetch).toHaveBeenCalledWith("/rpc/tasks/t1/icon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: "rocket" }),
    });
    expect(task.icon).toBe("rocket");
  });

  it("clears the icon with null", async () => {
    desktopFetch.mockResolvedValueOnce({ task: { id: "t1", icon: null } });

    const task = await taskApi.setTaskIcon("t1", null);

    expect(JSON.parse(desktopFetch.mock.calls[0][1].body)).toEqual({
      icon: null,
    });
    expect(task.icon).toBeNull();
  });
});
