import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/project-client", () => ({
  copyProjectEntry: vi.fn(),
  createProjectDirectory: vi.fn(),
  deleteProjectFile: vi.fn(),
  renameProjectEntry: vi.fn(),
  uploadProjectBinaryFile: vi.fn(),
  writeProjectFile: vi.fn(),
}));

import { useFilesStore } from "./files-store";

describe("requestDiffReveal", () => {
  beforeEach(() => {
    useFilesStore.setState({ diffReveal: null, diffRevealSeq: 0 });
  });

  it("starts with no pending request", () => {
    expect(useFilesStore.getState().diffReveal).toBeNull();
  });

  it("records the path and the diff scope that should answer", () => {
    useFilesStore.getState().requestDiffReveal("src/app.ts", "run-1");

    expect(useFilesStore.getState().diffReveal).toEqual({
      path: "src/app.ts",
      taskRunId: "run-1",
      token: 1,
    });
  });

  it("carries a null scope for the project working diff", () => {
    useFilesStore.getState().requestDiffReveal("src/app.ts", null);

    expect(useFilesStore.getState().diffReveal?.taskRunId).toBeNull();
  });

  it("bumps the token so clicking the same file twice scrolls twice", () => {
    const { requestDiffReveal } = useFilesStore.getState();
    requestDiffReveal("src/app.ts", "run-1");
    requestDiffReveal("src/app.ts", "run-1");

    expect(useFilesStore.getState().diffReveal).toEqual({
      path: "src/app.ts",
      taskRunId: "run-1",
      token: 2,
    });
  });

  it("ignores an empty path", () => {
    useFilesStore.getState().requestDiffReveal("", "run-1");

    expect(useFilesStore.getState().diffReveal).toBeNull();
  });

  it("clears a pending anchor when the whole diff is opened", () => {
    const { requestDiffReveal, clearDiffReveal } = useFilesStore.getState();
    requestDiffReveal("src/app.ts", "run-1");
    clearDiffReveal();

    expect(useFilesStore.getState().diffReveal).toBeNull();
  });

  it("keeps counting past a clear, so an open diff tab does not skip the request", () => {
    // A mounted diff tab remembers the last token it handled. Reusing token 1
    // after a clear would read as "already handled" and never scroll.
    const { requestDiffReveal, clearDiffReveal } = useFilesStore.getState();
    requestDiffReveal("src/app.ts", "run-1");
    clearDiffReveal();
    requestDiffReveal("src/app.ts", "run-1");

    expect(useFilesStore.getState().diffReveal?.token).toBe(2);
  });
});
