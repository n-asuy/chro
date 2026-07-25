import { beforeEach, describe, expect, it, vi } from "vitest";

const desktopFetch = vi.fn();
vi.mock("@/lib/backend-client", () => ({
  desktopFetch: (...args: unknown[]) => desktopFetch(...args),
}));

import { queryCbase } from "./cbase-client";

describe("queryCbase", () => {
  beforeEach(() => {
    desktopFetch.mockReset();
    desktopFetch.mockResolvedValue({
      properties: {},
      views: [],
      isQueryLanguage: false,
    });
  });

  it("forwards paging, view selection, and cancellation", async () => {
    const controller = new AbortController();
    await queryCbase("project", "version: 1", "tasks.cbase", {
      viewId: "open",
      offset: 250,
      limit: 250,
      signal: controller.signal,
    });

    const [, init] = desktopFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body as string)).toEqual({
      content: "version: 1",
      basePath: "tasks.cbase",
      viewId: "open",
      offset: 250,
      limit: 250,
    });
  });
});
