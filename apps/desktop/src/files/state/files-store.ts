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

interface FilesState {
  // Project context
  projectId: string | null;

  // Tree state
  rootPath: string | null;
  selectedPaths: string[];

  // File system data
  fileTree: FileNode[];

  // Current open file
  currentFilePath: string | null;

  // Inline editing state
  editingPath: string | null;
  editingName: string;

  // Incremented to trigger current-file reload when external modification is detected.
  fileContentVersion: number;
}

interface FilesActions {
  // Project management
  setProjectId: (projectId: string | null) => void;

  // Root management
  setRootPath: (path: string) => void;

  // Selection
  selectNode: (path: string, multiSelect?: boolean) => void;
  clearSelection: () => void;

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
  openFile: (path: string) => void;
  closeFile: () => void;

  // Inline editing
  startEditing: (path: string, initialName: string) => void;
  setEditingName: (name: string) => void;
  cancelEditing: () => void;
  commitEditing: () => Promise<void>;

  // Wikilink navigation (Obsidian-style)
  navigateToWikilink: (linkPath: string, subpath?: string) => void;

  // External file modification notification.
  notifyFileModified: (path: string) => void;
}

type FilesStore = FilesState & FilesActions;

export const useFilesStore = create<FilesStore>()((set, get) => ({
  // Initial state
  projectId: null,
  rootPath: null,
  selectedPaths: [],
  fileTree: [],
  currentFilePath: null,
  editingPath: null,
  editingName: "",
  fileContentVersion: 0,

  // Project management
  setProjectId: (projectId) => set({ projectId }),

  // Root management
  setRootPath: (path) => set({ rootPath: path }),

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
      return { fileTree: updateNodeRecursive(state.fileTree) };
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
    get().startEditing(newPath, displayName);

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
  openFile: (path) =>
    set(() => {
      if (!path) {
        return {};
      }
      return { currentFilePath: path };
    }),
  closeFile: () => set({ currentFilePath: null }),

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

  notifyFileModified: (path) => {
    const currentFilePath = get().currentFilePath;
    if (!currentFilePath || currentFilePath !== path) return;
    set((state) => ({ fileContentVersion: state.fileContentVersion + 1 }));
  },
}));
