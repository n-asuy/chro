import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/project-client", () => ({
  copyProjectEntry: vi.fn(),
  createProjectDirectory: vi.fn(),
  deleteProjectFile: vi.fn(),
  renameProjectEntry: vi.fn(),
  resolveProjectFile: vi.fn(),
  resolveTaskRunFile: vi.fn(),
  uploadProjectBinaryFile: vi.fn(),
  writeProjectFile: vi.fn(),
}));

import {
  resolveProjectFile,
  resolveTaskRunFile,
  writeProjectFile,
} from "@/lib/project-client";
import type { FileNode } from "../../types/file-tree";
import { FileNodeType } from "../../types/file-tree";
import { useFilesStore } from "../files-store";

const initialState = useFilesStore.getState();

const fileNode = (name: string, path: string): FileNode => ({
  id: path,
  name,
  displayName: name.endsWith(".md") ? name.slice(0, -3) : name,
  path,
  type: FileNodeType.File,
  relativePath: path.slice(1),
  metadata: { extension: name.split(".").pop() ?? "" },
});

beforeEach(() => {
  useFilesStore.setState(initialState, true);
  vi.mocked(resolveProjectFile).mockReset();
  vi.mocked(resolveTaskRunFile).mockReset();
  vi.mocked(writeProjectFile).mockReset();
});

describe("navigateToWikilink", () => {
  it("opens the server-resolved file on a tree miss instead of creating", async () => {
    useFilesStore.setState({ projectId: "p1", fileTree: [] });
    vi.mocked(resolveProjectFile).mockResolvedValue({
      root: "/proj",
      relative_path: "docs/note.md",
    });

    useFilesStore.getState().navigateToWikilink("note");

    await vi.waitFor(() => {
      expect(useFilesStore.getState().currentFilePath).toBe("/docs/note.md");
    });
    expect(resolveProjectFile).toHaveBeenCalledWith("p1", "note");
    expect(writeProjectFile).not.toHaveBeenCalled();
  });

  it("creates the note only after the server confirms it does not exist", async () => {
    useFilesStore.setState({ projectId: "p1", fileTree: [] });
    vi.mocked(resolveProjectFile).mockResolvedValue({
      root: null,
      relative_path: null,
    });
    vi.mocked(writeProjectFile).mockResolvedValue({} as never);

    useFilesStore.getState().navigateToWikilink("note");

    await vi.waitFor(() => {
      expect(useFilesStore.getState().currentFilePath).toBe("/note.md");
    });
    expect(writeProjectFile).toHaveBeenCalledWith("p1", "note.md", "");
  });

  it("matches an NFD tree node against an NFC link without the server", async () => {
    // "がき.md" stored decomposed, linked precomposed.
    const node = fileNode("\u{304B}\u{3099}\u{304D}.md", "/notes/がき.md");
    useFilesStore.setState({ projectId: "p1", fileTree: [node] });

    useFilesStore.getState().navigateToWikilink("\u{304C}\u{304D}");

    await vi.waitFor(() => {
      expect(useFilesStore.getState().currentFilePath).toBe(node.path);
    });
    expect(resolveProjectFile).not.toHaveBeenCalled();
  });

  it("resolves via the run's candidate roots in worktree scope and never creates", async () => {
    useFilesStore.setState({
      projectId: "p1",
      fileTree: [],
      scopeTaskRunId: "run-1",
    });
    vi.mocked(resolveTaskRunFile).mockResolvedValue({
      root: "/wt",
      relative_path: "docs/note.md",
    });

    useFilesStore.getState().navigateToWikilink("note");

    await vi.waitFor(() => {
      expect(useFilesStore.getState().currentFilePath).toBe("/wt/docs/note.md");
    });
    expect(resolveTaskRunFile).toHaveBeenCalledWith("run-1", "note");
    expect(writeProjectFile).not.toHaveBeenCalled();
  });
});

describe("openFilePath", () => {
  it("resolves a bare filename against the run's roots", async () => {
    useFilesStore.setState({ projectId: "p1", fileTree: [] });
    vi.mocked(resolveTaskRunFile).mockResolvedValue({
      root: "/wt",
      relative_path: "docs/design.html",
    });

    useFilesStore.getState().openFilePath("design.html", "run-1");

    await vi.waitFor(() => {
      expect(useFilesStore.getState().currentFilePath).toBe(
        "/wt/docs/design.html",
      );
    });
    expect(resolveTaskRunFile).toHaveBeenCalledWith("run-1", "design.html");
  });

  it("passes absolute paths straight to the reader", async () => {
    useFilesStore.setState({ projectId: "p1", fileTree: [] });

    useFilesStore.getState().openFilePath("/abs/design.html", "run-1");

    await vi.waitFor(() => {
      expect(useFilesStore.getState().currentFilePath).toBe("/abs/design.html");
    });
    expect(resolveTaskRunFile).not.toHaveBeenCalled();
  });

  it("falls back to the raw path when the run resolve finds nothing", async () => {
    useFilesStore.setState({ projectId: "p1", fileTree: [] });
    vi.mocked(resolveTaskRunFile).mockResolvedValue({
      root: null,
      relative_path: null,
    });

    useFilesStore.getState().openFilePath("missing.md", "run-1");

    await vi.waitFor(() => {
      expect(useFilesStore.getState().currentFilePath).toBe("missing.md");
    });
  });

  it("resolves a project-scope tree miss through the server index", async () => {
    useFilesStore.setState({ projectId: "p1", fileTree: [] });
    vi.mocked(resolveProjectFile).mockResolvedValue({
      root: "/proj",
      relative_path: "src/lib/util.ts",
    });

    useFilesStore.getState().openFilePath("util.ts");

    await vi.waitFor(() => {
      expect(useFilesStore.getState().currentFilePath).toBe(
        "/src/lib/util.ts",
      );
    });
    expect(resolveProjectFile).toHaveBeenCalledWith("p1", "util.ts");
  });
});
