import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PathLinkScope,
  resetPathLinkCache,
  resolvePathLink,
} from "../path-link";

const probeTaskPaths = vi.fn();
const probeProjectPaths = vi.fn();

vi.mock("@/lib/project-client", () => ({
  get probeTaskPaths() {
    return probeTaskPaths;
  },
  get probeProjectPaths() {
    return probeProjectPaths;
  },
}));

const TASK: PathLinkScope = { taskId: "task-1" };

const hit = (absolutePath: string) => ({
  exists: true,
  kind: "file" as const,
  absolute_path: absolutePath,
});
const miss = { exists: false };

/** Resolve everything queued for the current batch window. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  resetPathLinkCache();
  probeTaskPaths.mockReset();
  probeProjectPaths.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolvePathLink", () => {
  it("rejects text that cannot name a path without asking the server", async () => {
    const results = await Promise.all([
      resolvePathLink("useState", TASK),
      resolvePathLink("npm run build --watch --silent --force", TASK),
      resolvePathLink("https://chro-ai.com/docs", TASK),
      resolvePathLink('git commit -m "x"', TASK),
    ]);

    expect(results).toEqual([null, null, null, null]);
    expect(probeTaskPaths).not.toHaveBeenCalled();
  });

  it("resolves nothing when there is no scope to resolve against", async () => {
    expect(await resolvePathLink("src/main.rs", {})).toBeNull();
    expect(probeTaskPaths).not.toHaveBeenCalled();
  });

  it("coalesces every candidate requested in the same tick into one request", async () => {
    probeTaskPaths.mockResolvedValue([hit("/w/a.ts"), hit("/w/b.ts")]);

    const pending = Promise.all([
      resolvePathLink("src/a.ts", TASK),
      resolvePathLink("src/b.ts", TASK),
    ]);
    await settle();

    expect(await pending).toEqual([
      {
        kind: "file",
        absolutePath: "/w/a.ts",
        root: null,
        line: null,
        column: null,
      },
      {
        kind: "file",
        absolutePath: "/w/b.ts",
        root: null,
        line: null,
        column: null,
      },
    ]);
    expect(probeTaskPaths).toHaveBeenCalledTimes(1);
    expect(probeTaskPaths).toHaveBeenCalledWith("task-1", [
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("carries the resolved position through", async () => {
    probeTaskPaths.mockResolvedValue([
      { ...hit("/w/a.ts"), line: 12, column: 5, root: "/w" },
    ]);

    const pending = resolvePathLink("src/a.ts:12:5", TASK);
    await settle();

    expect(await pending).toEqual({
      kind: "file",
      absolutePath: "/w/a.ts",
      root: "/w",
      line: 12,
      column: 5,
    });
  });

  it("asks once per reference, then answers from cache", async () => {
    probeTaskPaths.mockResolvedValue([hit("/w/a.ts")]);

    const first = resolvePathLink("src/a.ts", TASK);
    await settle();
    await first;
    const second = await resolvePathLink("src/a.ts", TASK);

    expect(second?.absolutePath).toBe("/w/a.ts");
    expect(probeTaskPaths).toHaveBeenCalledTimes(1);
  });

  it("re-checks a reference that did not exist, once the miss goes stale", async () => {
    probeTaskPaths.mockResolvedValue([miss]);
    const first = resolvePathLink("out/report.html", TASK);
    await settle();
    expect(await first).toBeNull();

    // Still fresh: no second request.
    expect(await resolvePathLink("out/report.html", TASK)).toBeNull();
    expect(probeTaskPaths).toHaveBeenCalledTimes(1);

    // The agent writes the file, and the stale miss no longer suppresses it.
    await vi.advanceTimersByTimeAsync(30_001);
    probeTaskPaths.mockResolvedValue([hit("/w/out/report.html")]);
    const retry = resolvePathLink("out/report.html", TASK);
    await settle();

    expect((await retry)?.absolutePath).toBe("/w/out/report.html");
    expect(probeTaskPaths).toHaveBeenCalledTimes(2);
  });

  it("keeps scopes apart", async () => {
    probeTaskPaths.mockResolvedValue([hit("/run/a.ts")]);
    probeProjectPaths.mockResolvedValue([hit("/project/a.ts")]);

    const fromRun = resolvePathLink("src/a.ts", TASK);
    const fromProject = resolvePathLink("src/a.ts", { projectId: "p-1" });
    await settle();

    expect((await fromRun)?.absolutePath).toBe("/run/a.ts");
    expect((await fromProject)?.absolutePath).toBe("/project/a.ts");
  });

  it("does not cache a failed probe, so the next render retries", async () => {
    probeTaskPaths.mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = resolvePathLink("src/a.ts", TASK);
    await settle();
    expect(await failed).toBeNull();

    probeTaskPaths.mockResolvedValue([hit("/w/a.ts")]);
    const retry = resolvePathLink("src/a.ts", TASK);
    await settle();

    expect((await retry)?.absolutePath).toBe("/w/a.ts");
    expect(probeTaskPaths).toHaveBeenCalledTimes(2);
  });
});
