import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the URL each search hits and hand back a canned response, so the
// tests assert on the query the client builds and how it maps the reply.
const desktopFetch = vi.fn();
vi.mock("../backend-client", () => ({
  desktopFetch: (...args: unknown[]) => desktopFetch(...args),
  getBackendBaseUrl: () => "http://localhost",
}));

import { searchProjectContent, searchProjectFiles } from "../project-client";

const emptyResponse = {
  results: [],
  total_files: 0,
  total_line_matches: 0,
  truncated: false,
};

function lastUrl(): URL {
  const call = desktopFetch.mock.calls.at(-1);
  return new URL(call?.[0] as string, "http://localhost");
}

describe("searchProjectContent", () => {
  beforeEach(() => {
    desktopFetch.mockReset();
    desktopFetch.mockResolvedValue(emptyResponse);
  });

  it("forwards the sort order and content kind to the server", async () => {
    await searchProjectContent("proj", "needle", { sort: "modified-desc" });
    const url = lastUrl();
    expect(url.searchParams.get("kind")).toBe("content");
    expect(url.searchParams.get("sort")).toBe("modified-desc");
    expect(url.searchParams.get("q")).toBe("needle");
  });

  it("omits the sort param when none is given (server defaults to relevance)", async () => {
    await searchProjectContent("proj", "needle");
    expect(lastUrl().searchParams.has("sort")).toBe(false);
  });

  it("forwards cancellation to the backend request", async () => {
    const controller = new AbortController();
    await searchProjectContent("proj", "needle", {
      signal: controller.signal,
    });
    expect(desktopFetch.mock.calls.at(-1)?.[1]).toEqual({
      signal: controller.signal,
    });
  });

  it("maps totals and the truncation flag from the response", async () => {
    desktopFetch.mockResolvedValue({
      results: [
        {
          path: "a.md",
          is_file: true,
          match_type: "ContentMatch",
          line_matches: [],
          modified_at: "2026-07-22T00:00:00+00:00",
        },
      ],
      total_files: 500,
      total_line_matches: 1234,
      truncated: true,
    });

    const outcome = await searchProjectContent("proj", "needle");
    expect(outcome.results).toHaveLength(1);
    expect(outcome.totalFiles).toBe(500);
    expect(outcome.totalLineMatches).toBe(1234);
    expect(outcome.truncated).toBe(true);
  });

  it("short-circuits a blank query without calling the server", async () => {
    const outcome = await searchProjectContent("proj", "   ");
    expect(desktopFetch).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      results: [],
      totalFiles: 0,
      totalLineMatches: 0,
      truncated: false,
    });
  });
});

describe("searchProjectFiles", () => {
  beforeEach(() => {
    desktopFetch.mockReset();
    desktopFetch.mockResolvedValue(emptyResponse);
  });

  it("returns just the results array for name search", async () => {
    const results = await searchProjectFiles("proj", "readme");
    expect(results).toEqual([]);
    // Name search does not send kind=content or a sort order.
    const url = lastUrl();
    expect(url.searchParams.has("sort")).toBe(false);
    expect(url.searchParams.get("kind")).toBeNull();
  });
});
