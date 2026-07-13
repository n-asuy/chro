import {
  copyProjectEntry,
  createProjectDirectory,
  deleteProjectFile,
  renameProjectEntry,
  uploadProjectBinaryFile,
  writeProjectFile,
} from "@/lib/project-client";
import { create } from "zustand";
import type { FileNode } from "../types/file-tree";
import {
  FileNodeType,
  findNodeByPath,
  getActualFileName,
  getDisplayName,
} from "../types/file-tree";
import { useFileTreeStore } from "./file-tree-store";

const getSiblingNodes = (
  tree: FileNode[],
  parentPath: string,
  rootPath: string | null,
): FileNode[] => {
  if (!tree.length) return [];
  if (
    !parentPath ||
    parentPath === "/" ||
    (rootPath && parentPath === rootPath)
  ) {
    return tree;
  }

  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.path === parentPath) {
      return node.children ?? [];
    }
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }

  return [];
};

const sortFileNodes = (nodes: FileNode[]): FileNode[] =>
  [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === FileNodeType.Directory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

const findNodeInTree = (
  tree: FileNode[],
  predicate: (node: FileNode) => boolean,
): FileNode | null => {
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (predicate(node)) {
      return node;
    }
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }

  return null;
};

/**
 * A workspace root displayed at the top of the file tree. Modeled after
 * Zed's worktree concept: each root contributes a header row labeled with
 * its directory name, and the project's file nodes nest beneath it. The
 * structure is an array so multiple roots can be rendered side-by-side.
 *
 * Primary root: the project's bound workspace. Its children come from the
 * shared `fileTree` (loaded from the backend). Non-primary roots are added
 * via UI ("Add Folder to Project") and own their `children` directly.
 */
export interface WorkspaceRoot {
  /** Unique identifier used as the synthetic node path (also expansion key). */
  path: string;
  /** Raw directory name (e.g. "zed"). */
  name: string;
  /** Human-readable label rendered in the tree (project name or basename). */
  displayName: string;
  /** True for the project's bound workspace; false for ad-hoc folders. */
  isPrimary: boolean;
  /** Children of a non-primary root. Ignored for primary (uses fileTree). */
  children?: FileNode[];
}

/**
 * How the file tree presents a task run's worktree. "changed" lists only the
 * files the agent touched (sourced from the run's diff); "all" lists the whole
 * worktree directory tree (the same entries RPC the project root uses);
 * "gallery" replaces the tree with a grid of the run's renderable media. Only
 * meaningful while a worktree scope is active.
 */
export type WorktreeTreeView = "changed" | "all" | "gallery";

interface FilesState {
  // Project context
  projectId: string | null;

  // Active workspace scope. When set, the tree is displaying a task run's
  // worktree (a session sandbox) rather than the project's main checkout:
  // file opens are routed through that run and project-scoped mutations are
  // disabled. Null means the project root is the active scope.
  scopeTaskRunId: string | null;

  // How the worktree tree is presented (changed-only vs. full listing). Sticky
  // across sessions so the user's choice persists while switching runs. Ignored
  // outside worktree scope (the project root always lists everything).
  worktreeTreeView: WorktreeTreeView;

  // Tree state
  roots: WorkspaceRoot[];
  rootPath: string | null;
  selectedPaths: string[];

  // A pending "reveal this path in the tree" request. The bumped token lets the
  // file-tree panel (expand + hydrate the ancestors) and the FileTree view
  // (scroll the row into view) react even when the same path is revealed twice
  // in a row. Set by `revealPath`, e.g. from the Skills panel.
  revealRequest: { path: string; token: number } | null;

  // A pending "scroll the open editor to this line" request. Distinct from
  // `revealRequest` (which targets the file tree): this drives the CodeMirror
  // editor of the matching file to scroll a 1-based line into view, e.g. when
  // clicking a full-text search result. The bumped token re-triggers even when
  // the same file+line is requested twice.
  editorReveal: { path: string; line: number; token: number } | null;

  // File system data
  fileTree: FileNode[];

  // Current open file
  currentFilePath: string | null;

  // Inline editing state
  editingPath: string | null;
  editingName: string;

  // Incremented to trigger current-file reload when external modification is detected.
  fileContentVersion: number;

  // Bridge invoked by openFile/closeFile to surface the file in the UI.
  // Registered by LayoutShell, which opens the path as a tab in the focused
  // pane. The optional `taskRunId` lets callers route file reads through a
  // specific task run's worktree (e.g. when opening a file from a session view).
  _onFilePathChange: ((path: string | null, taskRunId?: string) => void) | null;
}

interface FilesActions {
  // Project management
  setProjectId: (projectId: string | null) => void;

  // Active workspace scope (see `scopeTaskRunId`). Setting a non-null run id
  // switches the tree into read-only worktree mode.
  setScopeTaskRunId: (taskRunId: string | null) => void;

  // Switch the worktree tree between changed-only and full-listing views.
  setWorktreeTreeView: (view: WorktreeTreeView) => void;

  // Root management
  setRoots: (roots: WorkspaceRoot[]) => void;
  addRoot: (root: WorkspaceRoot) => void;
  removeRoot: (path: string) => void;
  /** Replace the children of a non-primary root (no-op for primary). */
  setRootChildren: (rootPath: string, children: FileNode[]) => void;

  // Selection
  selectNode: (path: string, multiSelect?: boolean) => void;
  clearSelection: () => void;

  // Select a path and ask the file tree to expand to and scroll it into view.
  // Used to focus a directory (e.g. a skill package) without opening a file.
  revealPath: (path: string) => void;

  // File tree data
  setFileTree: (tree: FileNode[]) => void;
  updateNode: (path: string, updates: Partial<FileNode>) => void;
  updateNodes: (updates: Map<string, Partial<FileNode>>) => void;
  removeNode: (path: string) => void;

  // File operations
  createFile: (
    parentPath: string,
    name: string,
    extension?: string,
    initialContent?: string,
  ) => Promise<void>;
  createFolder: (parentPath: string, name: string) => Promise<void>;
  deleteNode: (path: string) => Promise<void>;
  renameNode: (oldPath: string, newName: string) => Promise<void>;
  renameDisplayName: (path: string, displayName: string) => Promise<void>;
  duplicateNode: (path: string) => Promise<void>;
  moveNode: (sourcePath: string, targetParentPath: string) => Promise<void>;
  importExternalFiles: (
    files: File[],
    targetParentPath: string,
  ) => Promise<void>;
  addNodeToTree: (parentPath: string, node: FileNode) => void;

  // Current file
  openFile: (path: string, taskRunId?: string) => void;
  // Ask the open editor for `path` to scroll to a 1-based line (e.g. a
  // content-search hit). Pure signal: it does not open the file, so the caller
  // controls how the tab is opened (and in which scope). Bumps `editorReveal`.
  requestEditorReveal: (path: string, line: number) => void;
  closeFile: () => void;

  // Inline editing
  startEditing: (path: string, initialName: string) => void;
  setEditingName: (name: string) => void;
  cancelEditing: () => void;
  commitEditing: () => Promise<void>;

  // Wikilink navigation (Obsidian-style)
  navigateToWikilink: (linkPath: string, subpath?: string) => void;

  // Open an arbitrary file path (e.g. agent-emitted code path) in a tab.
  //
  // Strips the trailing `:line[:col]` suffix and passes the rest through to
  // the server, which normalizes against the resource scope (task-run worktree
  // when `taskRunId` is set, otherwise the project root). Accepts absolute
  // paths under either root — see `path_resolve` in the server crate.
  openFilePath: (rawPath: string, taskRunId?: string) => void;

  // External file modification notification.
  notifyFileModified: (path: string) => void;
}

type FilesStore = FilesState & FilesActions;

export const useFilesStore = create<FilesStore>()((set, get) => ({
  // Initial state
  projectId: null,
  scopeTaskRunId: null,
  worktreeTreeView: "changed",
  roots: [],
  rootPath: null,
  selectedPaths: [],
  revealRequest: null,
  editorReveal: null,
  fileTree: [],
  currentFilePath: null,
  _onFilePathChange: null,
  editingPath: null,
  editingName: "",
  fileContentVersion: 0,

  // Project management
  setProjectId: (projectId) => set({ projectId }),

  setScopeTaskRunId: (taskRunId) => {
    if (get().scopeTaskRunId === taskRunId) return;
    set({ scopeTaskRunId: taskRunId });
  },

  setWorktreeTreeView: (view) => {
    if (get().worktreeTreeView === view) return;
    set({ worktreeTreeView: view });
  },

  // Root management
  setRoots: (roots) =>
    set({
      roots,
      rootPath: (roots.find((r) => r.isPrimary) ?? roots[0])?.path ?? null,
    }),

  addRoot: (root) =>
    set((state) => {
      if (state.roots.some((r) => r.path === root.path)) return state;
      return { roots: [...state.roots, root] };
    }),

  removeRoot: (path) =>
    set((state) => {
      const next = state.roots.filter((r) => r.path !== path);
      return {
        roots: next,
        rootPath: (next.find((r) => r.isPrimary) ?? next[0])?.path ?? null,
      };
    }),

  setRootChildren: (rootPath, children) =>
    set((state) => ({
      roots: state.roots.map((r) =>
        r.path === rootPath && !r.isPrimary ? { ...r, children } : r,
      ),
    })),

  // Selection
  selectNode: (path, multiSelect = false) =>
    set((state) => {
      if (multiSelect) {
        const isSelected = state.selectedPaths.includes(path);
        return {
          selectedPaths: isSelected
            ? state.selectedPaths.filter((p) => p !== path)
            : [...state.selectedPaths, path],
        };
      }
      return { selectedPaths: [path] };
    }),

  clearSelection: () => set({ selectedPaths: [] }),

  revealPath: (path) =>
    set((state) => ({
      selectedPaths: [path],
      revealRequest: { path, token: (state.revealRequest?.token ?? 0) + 1 },
    })),

  // File tree data
  setFileTree: (tree) => set({ fileTree: tree }),

  updateNode: (path, updates) =>
    set((state) => {
      const updateNodeRecursive = (nodes: FileNode[]): FileNode[] => {
        return nodes.map((node) => {
          if (node.path === path) {
            return { ...node, ...updates };
          }
          if (node.children) {
            return { ...node, children: updateNodeRecursive(node.children) };
          }
          return node;
        });
      };
      return {
        fileTree: updateNodeRecursive(state.fileTree),
        roots: state.roots.map((r) =>
          r.isPrimary || !r.children
            ? r
            : { ...r, children: updateNodeRecursive(r.children) },
        ),
      };
    }),

  updateNodes: (updates) =>
    set((state) => {
      const updateNodesRecursive = (nodes: FileNode[]): FileNode[] => {
        return nodes.map((node) => {
          const nodeUpdates = updates.get(node.path);
          const updatedNode = nodeUpdates ? { ...node, ...nodeUpdates } : node;
          if (updatedNode.children) {
            return {
              ...updatedNode,
              children: updateNodesRecursive(updatedNode.children),
            };
          }
          return updatedNode;
        });
      };
      return { fileTree: updateNodesRecursive(state.fileTree) };
    }),

  removeNode: (path) =>
    set((state) => {
      const removeNodeRecursive = (nodes: FileNode[]): FileNode[] => {
        return nodes.filter((node) => {
          if (node.path === path) {
            return false;
          }
          if (node.children) {
            node.children = removeNodeRecursive(node.children);
          }
          return true;
        });
      };
      return { fileTree: removeNodeRecursive(state.fileTree) };
    }),

  // File operations
  createFile: async (
    parentPath,
    name,
    extension = "md",
    initialContent = "",
  ) => {
    const state = get();
    if (state.scopeTaskRunId) {
      console.warn("[files-store] createFile is disabled in worktree scope");
      return;
    }
    if (!state.projectId) {
      console.error("[files-store] createFile requires projectId");
      throw new Error("Project not initialized");
    }
    const actualName = getActualFileName(name, FileNodeType.File, extension);
    const displayName = getDisplayName(actualName, FileNodeType.File);

    // Calculate relative path for the new file
    const parentNode = findNodeByPath(state.fileTree, parentPath);
    const parentRelative =
      parentNode?.relativePath ?? parentPath.replace(/^\/+/, "");
    const relativePath = parentRelative
      ? `${parentRelative}/${actualName}`
      : actualName;
    const newPath = `/${relativePath}`;

    // Set editing state BEFORE creating file to prevent SSE handler from adding duplicate
    get().startEditing(newPath, actualName);

    try {
      await writeProjectFile(state.projectId, relativePath, initialContent);

      // Create the new node
      const newNode: FileNode = {
        id: crypto.randomUUID(),
        name: actualName,
        displayName,
        path: newPath,
        type: FileNodeType.File,
        relativePath,
        metadata: {
          extension,
        },
      };

      // Add to tree
      get().addNodeToTree(parentPath, newNode);
      // Expand parent via file-tree-store
      useFileTreeStore.getState().expandPath(parentPath);
      get().selectNode(newPath);
    } catch (error) {
      console.error("[files-store] createFile failed:", error);
      get().cancelEditing();
      throw error;
    }
  },

  createFolder: async (parentPath, name) => {
    const state = get();
    if (state.scopeTaskRunId) {
      console.warn("[files-store] createFolder is disabled in worktree scope");
      return;
    }
    if (!state.projectId) {
      console.error("[files-store] createFolder requires projectId");
      throw new Error("Project not initialized");
    }
    // Calculate relative path for the new directory
    const parentNode = findNodeByPath(state.fileTree, parentPath);
    const parentRelative =
      parentNode?.relativePath ?? parentPath.replace(/^\/+/, "");
    const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
    const newPath = `/${relativePath}`;

    // Set editing state BEFORE creating folder to prevent SSE handler from adding duplicate
    get().startEditing(newPath, name);

    try {
      await createProjectDirectory(state.projectId, relativePath);

      // Create the new node (folders: name === displayName)
      const newNode: FileNode = {
        id: crypto.randomUUID(),
        name,
        displayName: name,
        path: newPath,
        type: FileNodeType.Directory,
        relativePath,
        children: [],
        hasChildren: false,
        isHydrated: true,
      };

      // Add to tree
      get().addNodeToTree(parentPath, newNode);
      // Expand parent via file-tree-store
      useFileTreeStore.getState().expandPath(parentPath);
      get().selectNode(newPath);
    } catch (error) {
      console.error("[files-store] createFolder failed:", error);
      get().cancelEditing();
      throw error;
    }
  },

  deleteNode: async (path) => {
    const state = get();
    if (state.scopeTaskRunId) {
      console.warn("[files-store] deleteNode is disabled in worktree scope");
      return;
    }
    if (!state.projectId) {
      console.error("[files-store] deleteNode requires projectId");
      throw new Error("Project not initialized");
    }
    const node = findNodeByPath(state.fileTree, path);
    if (!node) {
      console.warn("[files-store] deleteNode: node not found", path);
      return;
    }
    const relativePath = node.relativePath ?? path.replace(/^\/+/, "");
    try {
      await deleteProjectFile(state.projectId, relativePath);
      get().removeNode(path);
    } catch (error) {
      console.error("[files-store] deleteProjectFile failed:", error);
      throw error;
    }
  },

  renameNode: async (oldPath, newName) => {
    const state = get();
    if (state.scopeTaskRunId) {
      console.warn("[files-store] renameNode is disabled in worktree scope");
      return;
    }
    if (!state.projectId) {
      console.error("[files-store] renameNode requires projectId");
      throw new Error("Project not initialized");
    }
    const node = findNodeByPath(state.fileTree, oldPath);
    if (!node) {
      console.warn("[files-store] renameNode: node not found", oldPath);
      return;
    }

    const oldRelative = node.relativePath ?? oldPath.replace(/^\/+/, "");
    const parentDir = oldRelative.includes("/")
      ? oldRelative.substring(0, oldRelative.lastIndexOf("/"))
      : "";
    const newRelative = parentDir ? `${parentDir}/${newName}` : newName;

    try {
      await renameProjectEntry(state.projectId, oldRelative, newRelative);
    } catch (error) {
      console.error("[files-store] renameNode failed:", error);
      throw error;
    }

    const newPath = `/${newRelative}`;
    const newDisplayName = getDisplayName(newName, node.type);

    get().updateNode(oldPath, {
      name: newName,
      displayName: newDisplayName,
      path: newPath,
      relativePath: newRelative,
    });

    set((currentState) => ({
      selectedPaths: currentState.selectedPaths.map((p) =>
        p === oldPath ? newPath : p,
      ),
      currentFilePath:
        currentState.currentFilePath === oldPath
          ? newPath
          : currentState.currentFilePath,
    }));
  },

  renameDisplayName: async (path, displayName) => {
    const state = get();
    const node = findNodeByPath(state.fileTree, path);
    if (!node) {
      throw new Error("File not found");
    }

    const trimmed = displayName.trim();
    if (!trimmed) {
      throw new Error("Title is required");
    }

    const newActualName = getActualFileName(
      trimmed,
      node.type,
      node.metadata?.extension ?? "md",
    );
    if (newActualName === node.name) {
      return;
    }

    const parentPath = node.path.includes("/")
      ? node.path.substring(0, node.path.lastIndexOf("/")) || "/"
      : "/";
    const siblings = getSiblingNodes(
      state.fileTree,
      parentPath,
      state.rootPath,
    );
    const duplicate = siblings.some(
      (sibling) => sibling.path !== node.path && sibling.name === newActualName,
    );

    if (duplicate) {
      throw new Error("A file with that name already exists");
    }

    await get().renameNode(path, newActualName);
  },

  duplicateNode: async (path) => {
    const state = get();
    if (state.scopeTaskRunId) {
      console.warn("[files-store] duplicateNode is disabled in worktree scope");
      return;
    }
    if (!state.projectId) {
      console.error("[vault-store] duplicateNode requires projectId");
      throw new Error("Project not initialized");
    }

    const node = findNodeByPath(state.fileTree, path);
    if (!node) {
      console.warn("[vault-store] duplicateNode: node not found", path);
      return;
    }

    const sourceRelative = node.relativePath ?? path.replace(/^\/+/, "");
    const parentPath = node.path.includes("/")
      ? node.path.substring(0, node.path.lastIndexOf("/")) || "/"
      : "/";
    const siblings = getSiblingNodes(
      state.fileTree,
      parentPath,
      state.rootPath,
    );

    // Generate unique name: "name" -> "name copy", "name copy" -> "name copy 2", etc.
    const nodeExt = node.metadata?.extension;
    const dotExt =
      node.type === FileNodeType.File && nodeExt ? `.${nodeExt}` : "";
    const baseName =
      node.type === FileNodeType.File && dotExt && node.name.endsWith(dotExt)
        ? node.name.slice(0, -dotExt.length)
        : node.name;
    const extension = dotExt;

    let copyName = `${baseName} copy${extension}`;
    let counter = 2;
    while (siblings.some((sibling) => sibling.name === copyName)) {
      copyName = `${baseName} copy ${counter}${extension}`;
      counter++;
    }

    const parentDir = sourceRelative.includes("/")
      ? sourceRelative.substring(0, sourceRelative.lastIndexOf("/"))
      : "";
    const destRelative = parentDir ? `${parentDir}/${copyName}` : copyName;

    try {
      const copiedEntry = await copyProjectEntry(
        state.projectId,
        sourceRelative,
        destRelative,
      );

      const newPath = `/${destRelative}`;
      const newNode: FileNode = {
        id: crypto.randomUUID(),
        name: copiedEntry.name,
        displayName: copiedEntry.displayName,
        path: newPath,
        type:
          copiedEntry.type === "directory"
            ? FileNodeType.Directory
            : FileNodeType.File,
        relativePath: copiedEntry.relativePath,
        hasChildren: copiedEntry.hasChildren,
        children: copiedEntry.type === "directory" ? [] : undefined,
        isHydrated: false,
        metadata:
          copiedEntry.type === "file"
            ? { extension: copiedEntry.extension ?? undefined }
            : undefined,
      };

      get().addNodeToTree(parentPath, newNode);
      get().selectNode(newPath);
    } catch (error) {
      console.error("[vault-store] duplicateNode failed:", error);
      throw error;
    }
  },

  moveNode: async (sourcePath, targetParentPath) => {
    const state = get();
    if (state.scopeTaskRunId) {
      console.warn("[files-store] moveNode is disabled in worktree scope");
      return;
    }
    if (!state.projectId) {
      console.error("[files-store] moveNode requires projectId");
      throw new Error("Project not initialized");
    }

    const sourceNode = findNodeByPath(state.fileTree, sourcePath);
    if (!sourceNode) {
      console.warn("[files-store] moveNode: source node not found", sourcePath);
      return;
    }

    // Calculate relative paths
    const oldRelative =
      sourceNode.relativePath ?? sourcePath.replace(/^\/+/, "");
    const targetParentNode = findNodeByPath(state.fileTree, targetParentPath);
    const targetParentRelative =
      targetParentNode?.relativePath ?? targetParentPath.replace(/^\/+/, "");

    // Build new relative path
    const newRelative = targetParentRelative
      ? `${targetParentRelative}/${sourceNode.name}`
      : sourceNode.name;

    // Prevent moving to same location
    if (oldRelative === newRelative) {
      return;
    }

    // Check for duplicate in target
    const targetChildren = targetParentNode?.children ?? state.fileTree;
    const duplicate = targetChildren.some(
      (child) => child.name === sourceNode.name && child.path !== sourcePath,
    );
    if (duplicate) {
      throw new Error(
        "A file with that name already exists in the target folder",
      );
    }

    try {
      // Use rename API for move (it handles path changes)
      await renameProjectEntry(state.projectId, oldRelative, newRelative);
    } catch (error) {
      console.error("[files-store] moveNode failed:", error);
      throw error;
    }

    // Update tree state
    const newPath = `/${newRelative}`;

    // Helper to update paths recursively for directories
    const updateChildPaths = (
      node: FileNode,
      oldBasePath: string,
      newBasePath: string,
    ): FileNode => {
      const updatedPath = node.path.replace(oldBasePath, newBasePath);
      const updatedRelative = updatedPath.replace(/^\/+/, "");
      return {
        ...node,
        path: updatedPath,
        relativePath: updatedRelative,
        children: node.children?.map((child) =>
          updateChildPaths(child, oldBasePath, newBasePath),
        ),
      };
    };

    // Create moved node with updated paths
    const movedNode = updateChildPaths(sourceNode, sourcePath, newPath);

    // Remove from old location and add to new
    get().removeNode(sourcePath);
    get().addNodeToTree(targetParentPath, movedNode);

    // Update selection and current file if needed
    set((currentState) => ({
      selectedPaths: currentState.selectedPaths.map((p) => {
        if (p === sourcePath) return newPath;
        if (p.startsWith(`${sourcePath}/`)) {
          return p.replace(sourcePath, newPath);
        }
        return p;
      }),
      currentFilePath: (() => {
        const cfp = currentState.currentFilePath;
        if (!cfp) return null;
        if (cfp === sourcePath) return newPath;
        if (cfp.startsWith(`${sourcePath}/`)) {
          return cfp.replace(sourcePath, newPath);
        }
        return cfp;
      })(),
    }));

    // Expand target parent
    useFileTreeStore.getState().expandPath(targetParentPath);
  },

  importExternalFiles: async (files, targetParentPath) => {
    const state = get();
    if (state.scopeTaskRunId) {
      console.warn(
        "[files-store] importExternalFiles is disabled in worktree scope",
      );
      return;
    }
    if (!state.projectId) {
      console.error("[files-store] importExternalFiles requires projectId");
      throw new Error("Project not initialized");
    }

    const targetParentNode = findNodeByPath(state.fileTree, targetParentPath);
    const targetParentRelative =
      targetParentNode?.relativePath ?? targetParentPath.replace(/^\/+/, "");

    const existingChildren =
      targetParentNode?.children ??
      (targetParentPath === "/" || targetParentPath === state.rootPath
        ? state.fileTree
        : []);
    const existingNames = new Set(existingChildren.map((c) => c.name));

    for (const file of files) {
      const originalName = file.name;
      let fileName = originalName;
      let counter = 1;

      // Handle name conflicts
      while (existingNames.has(fileName)) {
        const dotIndex = originalName.lastIndexOf(".");
        if (dotIndex > 0) {
          const base = originalName.slice(0, dotIndex);
          const ext = originalName.slice(dotIndex);
          fileName = `${base} (${counter})${ext}`;
        } else {
          fileName = `${originalName} (${counter})`;
        }
        counter++;
      }
      existingNames.add(fileName);

      const relativePath = targetParentRelative
        ? `${targetParentRelative}/${fileName}`
        : fileName;

      try {
        // Determine if it's a text file (markdown) or binary
        const isTextFile =
          file.type.startsWith("text/") ||
          file.name.endsWith(".md") ||
          file.name.endsWith(".txt") ||
          file.name.endsWith(".json") ||
          file.name.endsWith(".yaml") ||
          file.name.endsWith(".yml");

        if (isTextFile) {
          const content = await file.text();
          await writeProjectFile(state.projectId, relativePath, content);
        } else {
          await uploadProjectBinaryFile(state.projectId, relativePath, file);
        }

        // Create new node
        const newPath = `/${relativePath}`;
        const extension = fileName.includes(".")
          ? fileName.split(".").pop() ?? null
          : null;

        const newNode: FileNode = {
          id: crypto.randomUUID(),
          name: fileName,
          displayName: getDisplayName(fileName, FileNodeType.File),
          path: newPath,
          type: FileNodeType.File,
          relativePath,
          metadata: {
            extension: extension ?? undefined,
          },
        };

        get().addNodeToTree(targetParentPath, newNode);
      } catch (error) {
        console.error(
          `[files-store] Failed to import file ${fileName}:`,
          error,
        );
      }
    }

    // Expand target parent
    useFileTreeStore.getState().expandPath(targetParentPath);
  },

  addNodeToTree: (parentPath, node) =>
    set((state) => {
      const addToParent = (nodes: FileNode[]): FileNode[] => {
        // If parentPath is root or empty, add to top level
        if (
          !parentPath ||
          parentPath === "/" ||
          parentPath === state.rootPath
        ) {
          // Insert sorted: directories first, then alphabetically
          return sortFileNodes([...nodes, node]);
        }

        return nodes.map((n) => {
          if (n.path === parentPath && n.type === FileNodeType.Directory) {
            const children = n.children ?? [];
            const newChildren = sortFileNodes([...children, node]);
            return { ...n, children: newChildren, hasChildren: true };
          }
          if (n.children) {
            return { ...n, children: addToParent(n.children) };
          }
          return n;
        });
      };
      return { fileTree: addToParent(state.fileTree) };
    }),

  // Current file
  openFile: (path, taskRunId) => {
    if (!path) return;
    const state = get();
    if (state.currentFilePath !== path) {
      set({ currentFilePath: path });
    }
    // Default to the active worktree scope so files clicked in a session
    // sandbox tree read from that run's worktree, not the project checkout.
    const effectiveRunId = taskRunId ?? state.scopeTaskRunId ?? undefined;
    state._onFilePathChange?.(path, effectiveRunId);
  },
  requestEditorReveal: (path, line) => {
    if (!path) return;
    set((state) => ({
      editorReveal: {
        path,
        line,
        token: (state.editorReveal?.token ?? 0) + 1,
      },
    }));
  },
  closeFile: () => {
    if (get().currentFilePath === null) return;
    set({ currentFilePath: null });
    get()._onFilePathChange?.(null);
  },

  // Inline editing
  startEditing: (path, initialName) => {
    set({ editingPath: path, editingName: initialName });
  },

  setEditingName: (name) => set({ editingName: name }),

  cancelEditing: () => set({ editingPath: null, editingName: "" }),

  commitEditing: async () => {
    const state = get();
    if (!state.editingPath) return;

    try {
      await get().renameDisplayName(state.editingPath, state.editingName);
    } catch (error) {
      console.error("[files-store] commitEditing failed:", error);
    } finally {
      get().cancelEditing();
    }
  },

  navigateToWikilink: (linkPath: string, _subpath?: string) => {
    const state = get();
    const { fileTree, selectNode, openFile } = state;
    const { expandPath } = useFileTreeStore.getState();

    // Remove any anchor/section references for now (subpath handled later)
    const cleanPath = linkPath.split("#")[0];

    // Try to find the file in the tree
    // Obsidian allows referencing files by:
    // 1. Full relative path: folder/subfolder/note.md
    // 2. Just filename: note.md or note (without extension)
    // 3. Display name

    let targetNode: FileNode | null = null;

    // First, try exact path match (with .md extension if not present)
    const pathWithExt = cleanPath.endsWith(".md")
      ? cleanPath
      : `${cleanPath}.md`;
    const fullPath = `/${pathWithExt}`;
    targetNode = findNodeByPath(fileTree, fullPath);

    // If not found, search by filename
    if (!targetNode) {
      const searchFileName = pathWithExt.split("/").pop() ?? pathWithExt;
      targetNode = findNodeInTree(
        fileTree,
        (node) =>
          node.type === FileNodeType.File && node.name === searchFileName,
      );
    }

    // If still not found, try matching display name
    if (!targetNode) {
      const searchDisplayName = cleanPath.split("/").pop() ?? cleanPath;
      targetNode = findNodeInTree(
        fileTree,
        (node) =>
          node.type === FileNodeType.File &&
          node.displayName === searchDisplayName,
      );
    }

    if (targetNode) {
      // Expand parent folders
      const parts = targetNode.path.split("/").filter(Boolean);
      let currentPath = "";
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += `/${parts[i]}`;
        expandPath(currentPath);
      }

      // Select and open the file
      selectNode(targetNode.path);
      openFile(targetNode.path);
    } else {
      // In worktree (read-only) scope we never create files; just attempt to
      // open so the server resolves the path against the run's worktree.
      if (state.scopeTaskRunId) {
        openFile(`/${pathWithExt}`);
        return;
      }
      // Create the file if it doesn't exist (Obsidian behavior)
      const { projectId, rootPath, addNodeToTree } = state;
      if (!projectId) {
        console.error("[files-store] Cannot create file: projectId not set");
        return;
      }

      // Determine the path for the new file
      // If linkPath contains '/', treat it as a relative path from root
      // Otherwise, create it in the root directory
      const relativePath = pathWithExt.startsWith("/")
        ? pathWithExt.slice(1)
        : pathWithExt;

      // Create parent directories if needed
      const pathParts = relativePath.split("/");
      const fileName = pathParts.pop() ?? relativePath;
      const parentRelative = pathParts.join("/");

      // Create the file
      writeProjectFile(projectId, relativePath, "")
        .then(() => {
          const newPath = `/${relativePath}`;
          const displayName = getDisplayName(fileName, FileNodeType.File);

          const newNode: FileNode = {
            id: crypto.randomUUID(),
            name: fileName,
            displayName,
            path: newPath,
            type: FileNodeType.File,
            relativePath,
            metadata: {
              extension: "md",
            },
          };

          // Determine parent path for tree insertion
          const parentPath = parentRelative
            ? `/${parentRelative}`
            : rootPath ?? "/";
          addNodeToTree(parentPath, newNode);

          // Expand parent folders
          if (parentRelative) {
            let currentPath = "";
            for (const part of pathParts) {
              currentPath += `/${part}`;
              expandPath(currentPath);
            }
          }

          // Select and open the new file
          selectNode(newPath);
          openFile(newPath);
        })
        .catch((error) => {
          console.error(
            "[files-store] Failed to create wikilink target:",
            error,
          );
        });
    }
  },

  openFilePath: (rawPath: string, taskRunId?: string) => {
    if (!rawPath) return;
    const state = get();
    const { fileTree, selectNode, openFile } = state;
    const { expandPath } = useFileTreeStore.getState();

    const stripped = rawPath.trim().replace(/:\d+(?::\d+)?$/, "");
    if (!stripped) return;

    // When opening through a task run, the file lives in that run's worktree
    // and is read by the server (which normalizes any prefix — project root or
    // worktree absolute — against the run's roots; see `path_resolve` in the
    // server crate). The path is therefore passed through unchanged.
    if (taskRunId) {
      openFile(stripped, taskRunId);
      return;
    }

    // For project-scoped opens the client maintains a virtual file tree keyed
    // by a leading slash; try to land on a node so the tree can highlight /
    // expand the right ancestors. The server will normalize the eventual
    // request, so a missing node is not fatal — just a UX nicety.
    const normalized = stripped.startsWith("/") ? stripped : `/${stripped}`;
    let targetNode = findNodeByPath(fileTree, normalized);

    if (!targetNode) {
      const fileName = stripped.split("/").pop() ?? stripped;
      if (fileName) {
        targetNode = findNodeInTree(
          fileTree,
          (node) => node.type === FileNodeType.File && node.name === fileName,
        );
      }
    }

    const resolvedPath = targetNode?.path ?? normalized;

    if (targetNode) {
      const parts = targetNode.path.split("/").filter(Boolean);
      let currentPath = "";
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += `/${parts[i]}`;
        expandPath(currentPath);
      }
      selectNode(targetNode.path);
    }

    openFile(resolvedPath);
  },

  notifyFileModified: (path) => {
    const currentFilePath = get().currentFilePath;
    if (!currentFilePath || currentFilePath !== path) return;
    set((state) => ({ fileContentVersion: state.fileContentVersion + 1 }));
  },
}));
