import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/project-client", () => ({
  copyProjectEntry: vi.fn(),
  createProjectDirectory: vi.fn(),
  deleteProjectFile: vi.fn(),
  renameProjectEntry: vi.fn(),
  uploadProjectBinaryFile: vi.fn(),
  writeProjectFile: vi.fn(),
}));

import { deleteProjectFile, renameProjectEntry } from "@/lib/project-client";
import type { FileNode } from "../types/file-tree";
import { FileNodeType } from "../types/file-tree";
import { useFilesStore } from "./files-store";

const file = (path: string): FileNode => ({
  id: path,
  name: path.split("/").pop() ?? path,
  displayName: path.split("/").pop() ?? path,
  path,
  relativePath: path.replace(/^\/+/, ""),
  type: FileNodeType.File,
});

const folder = (path: string, children: FileNode[] = []): FileNode => ({
  id: path,
  name: path.split("/").pop() ?? path,
  displayName: path.split("/").pop() ?? path,
  path,
  relativePath: path.replace(/^\/+/, ""),
  type: FileNodeType.Directory,
  children,
  hasChildren: children.length > 0,
  isHydrated: true,
});

const createTree = (): FileNode[] => [
  folder("/folder", [file("/folder/child.md")]),
  folder("/target"),
  file("/a.md"),
  file("/b.md"),
];

describe("file tree selection and batch operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFilesStore.setState({
      projectId: "project-1",
      scopeTaskRunId: null,
      rootPath: "/",
      roots: [],
      fileTree: createTree(),
      selectedPaths: [],
      currentFilePath: null,
      _onFilePathChange: null,
    });
  });

  it("sets an ordered, deduplicated selection", () => {
    useFilesStore.getState().selectNodes(["/a.md", "/b.md", "/a.md", ""]);

    expect(useFilesStore.getState().selectedPaths).toEqual(["/a.md", "/b.md"]);
  });

  it("deletes only top-level selected paths and clears deleted state", async () => {
    vi.mocked(deleteProjectFile).mockResolvedValue("deleted");
    const onFilePathChange = vi.fn();
    useFilesStore.setState({
      selectedPaths: ["/folder", "/folder/child.md", "/b.md"],
      currentFilePath: "/folder/child.md",
      _onFilePathChange: onFilePathChange,
    });

    await useFilesStore
      .getState()
      .deleteNodes(["/folder", "/folder/child.md", "/b.md"]);

    expect(deleteProjectFile).toHaveBeenNthCalledWith(1, "project-1", "folder");
    expect(deleteProjectFile).toHaveBeenNthCalledWith(2, "project-1", "b.md");
    expect(useFilesStore.getState().fileTree.map((node) => node.path)).toEqual([
      "/target",
      "/a.md",
    ]);
    expect(useFilesStore.getState().selectedPaths).toEqual([]);
    expect(useFilesStore.getState().currentFilePath).toBeNull();
    expect(onFilePathChange).toHaveBeenCalledWith(null);
  });

  it("keeps failed deletions selected while removing successful ones", async () => {
    vi.mocked(deleteProjectFile)
      .mockResolvedValueOnce("a.md")
      .mockRejectedValueOnce(new Error("locked"));
    useFilesStore.setState({ selectedPaths: ["/a.md", "/b.md"] });

    await expect(
      useFilesStore.getState().deleteNodes(["/a.md", "/b.md"]),
    ).rejects.toThrow("Failed to delete 1 of 2 selected items");

    expect(useFilesStore.getState().fileTree.map((node) => node.path)).toEqual([
      "/folder",
      "/target",
      "/b.md",
    ]);
    expect(useFilesStore.getState().selectedPaths).toEqual(["/b.md"]);
  });

  it("moves multiple selected entries and preserves their selection", async () => {
    vi.mocked(renameProjectEntry).mockResolvedValue("moved");
    useFilesStore.setState({ selectedPaths: ["/a.md", "/folder"] });

    await useFilesStore.getState().moveNodes(["/a.md", "/folder"], "/target");

    expect(renameProjectEntry).toHaveBeenNthCalledWith(
      1,
      "project-1",
      "a.md",
      "target/a.md",
    );
    expect(renameProjectEntry).toHaveBeenNthCalledWith(
      2,
      "project-1",
      "folder",
      "target/folder",
    );
    const target = useFilesStore
      .getState()
      .fileTree.find((node) => node.path === "/target");
    expect(target?.children?.map((node) => node.path)).toEqual([
      "/target/folder",
      "/target/a.md",
    ]);
    expect(useFilesStore.getState().selectedPaths).toEqual([
      "/target/a.md",
      "/target/folder",
    ]);
  });

  it("rejects a conflicting batch before moving anything", async () => {
    useFilesStore.setState({
      fileTree: [folder("/target", [file("/target/a.md")]), file("/a.md")],
    });

    await expect(
      useFilesStore.getState().moveNodes(["/a.md"], "/target"),
    ).rejects.toThrow("already exists");

    expect(renameProjectEntry).not.toHaveBeenCalled();
  });

  it("rejects moving a folder into one of its descendants", async () => {
    useFilesStore.setState({
      fileTree: [folder("/folder", [folder("/folder/subfolder")])],
    });

    await expect(
      useFilesStore.getState().moveNodes(["/folder"], "/folder/subfolder"),
    ).rejects.toThrow("cannot be moved into itself");

    expect(renameProjectEntry).not.toHaveBeenCalled();
  });
});
