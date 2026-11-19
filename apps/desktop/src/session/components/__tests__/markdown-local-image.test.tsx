/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../markdown";
import { resetPathLinkCache } from "../path-link";
import { PathLinkScopeProvider } from "../use-path-link";

/**
 * A local image an agent writes into its reply. An absolute path
 * (`![shot](/tmp/shot.png)`) loads directly. A relative one (`out/shot.png`)
 * is only loadable once its path resolves; until then it is loading, not
 * missing: the "?" placeholder is reserved for a path known not to exist.
 */

const probeTaskPaths = vi.fn();

vi.mock("@/lib/project-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-client")>()),
  get probeTaskPaths() {
    return probeTaskPaths;
  },
  getWorkspaceBinaryFileUrl: (root: string, relativePath: string) =>
    `binary:${root}|${relativePath}`,
}));

const hit = {
  exists: true,
  kind: "file" as const,
  absolute_path: "/w/out/shot.png",
};

let container: HTMLDivElement;
let root: Root;

const render = (source = "![shot](out/shot.png)") => {
  act(() => {
    root.render(
      <PathLinkScopeProvider value={{ taskId: "task-1" }}>
        <Markdown>{source}</Markdown>
      </PathLinkScopeProvider>,
    );
  });
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const imageState = () =>
  container
    .querySelector("[data-image-state]")
    ?.getAttribute("data-image-state") ?? null;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  resetPathLinkCache();
  probeTaskPaths.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Markdown local images", () => {
  it("loads an absolute path at once, without waiting on a probe", async () => {
    probeTaskPaths.mockReturnValue(new Promise(() => undefined));

    render("![shot](/tmp/shot.png)");

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "binary:/tmp|shot.png",
    );
    await advance(1_000);
    expect(probeTaskPaths).not.toHaveBeenCalled();
  });

  it("marks an absolute path missing when the file cannot be loaded", () => {
    render("![shot](/tmp/gone.png)");

    act(() => {
      container.querySelector("img")?.dispatchEvent(new Event("error"));
    });

    expect(imageState()).toBe("missing");
  });

  it("shows the image as loading, not missing, while its path resolves", async () => {
    probeTaskPaths.mockReturnValue(new Promise(() => undefined));

    render();
    await advance(1_000);

    expect(imageState()).toBe("loading");
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows the image once its path resolves", async () => {
    probeTaskPaths.mockResolvedValue([hit]);

    render();
    await advance(1_000);

    expect(imageState()).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "binary:/w/out|shot.png",
    );
  });

  it("marks the image missing only when the path is known not to exist", async () => {
    probeTaskPaths.mockResolvedValue([{ exists: false }]);

    render();
    await advance(1_000);

    expect(imageState()).toBe("missing");
  });

  it("retries a failed probe instead of leaving the image missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    probeTaskPaths
      .mockRejectedValueOnce(new Error("server busy"))
      .mockResolvedValue([hit]);

    render();
    await advance(1_000);
    expect(imageState()).toBe("loading");

    await advance(30_000);

    expect(probeTaskPaths).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "binary:/w/out|shot.png",
    );
  });
});
