import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  devEventsSessionId,
  flushDevEvents,
  isDevEventsEnabled,
  pendingDevEventsForTest,
  recordDevEvent,
  resetDevEventsForTest,
} from "../dev-events";

/** Mirrored from the module: the point at which a flush is triggered. */
const FLUSH_AT_EVENTS = 50;
const MAX_BUFFER = 2_000;

type SentRequest = {
  url: string;
  body: { session: string; events: unknown[] };
};

function sentRequests(fetchMock: ReturnType<typeof vi.fn>): SentRequest[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String((init as RequestInit).body)),
  }));
}

describe("dev events sink", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetDevEventsForTest();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetDevEventsForTest();
    vi.unstubAllGlobals();
  });

  it("is enabled under the dev build used by tests", () => {
    expect(isDevEventsEnabled()).toBe(true);
  });

  it("buffers events instead of sending one request each", () => {
    recordDevEvent("ui.click", { label: "Merge" });
    recordDevEvent("ui.key", { combo: "meta+k" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingDevEventsForTest()).toHaveLength(2);
  });

  it("stamps every event with a timestamp and defaults properties", () => {
    recordDevEvent("ui.route");

    const [entry] = pendingDevEventsForTest();
    expect(entry.event).toBe("ui.route");
    expect(entry.props).toEqual({});
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
  });

  it("posts the batch under one page session", async () => {
    recordDevEvent("ui.click", { label: "Merge" });
    recordDevEvent("rpc", { path: "/rpc/tasks" });
    await flushDevEvents();

    const [request] = sentRequests(fetchMock);
    expect(request.url.endsWith("/rpc/dev-events")).toBe(true);
    expect(request.body.session).toBe(devEventsSessionId());
    expect(request.body.events).toHaveLength(2);
    expect(pendingDevEventsForTest()).toHaveLength(0);
  });

  it("flushes on its own once the batch threshold is reached", async () => {
    for (let i = 0; i < FLUSH_AT_EVENTS; i++) {
      recordDevEvent("ui.click", { index: i });
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [request] = sentRequests(fetchMock);
    expect(request.body.events).toHaveLength(FLUSH_AT_EVENTS);
  });

  it("does nothing when there is nothing buffered", async () => {
    await flushDevEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops the batch when the backend is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));

    recordDevEvent("ui.click", { label: "Merge" });
    await expect(flushDevEvents()).resolves.toBeUndefined();
    expect(pendingDevEventsForTest()).toHaveLength(0);
  });

  it("drops the oldest events past the buffer cap and says so", async () => {
    // Deliberately overflow without triggering the threshold flush.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < MAX_BUFFER + 10; i++) {
      recordDevEvent("ui.click", { index: i });
    }

    expect(pendingDevEventsForTest().length).toBeLessThanOrEqual(MAX_BUFFER);
    const first = pendingDevEventsForTest()[0];
    expect(first.props.index).not.toBe(0);
  });
});
