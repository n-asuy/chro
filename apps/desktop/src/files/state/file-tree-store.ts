import { create } from "zustand";
import {
  loadExpandedPaths,
  saveExpandedPaths,
} from "../lib/tree-state-persistence";

interface FileTreeState {
  expandedPaths: Set<string>;
  workspacePath: string | null;
  /** Handler injected from vault-shell for on-demand hydration */
  toggleFolderHandler: ((path: string) => Promise<void>) | null;
}

interface FileTreeActions {
  initializeExpandedPaths: (workspacePath: string | null) => void;
  /** Toggle folder UI state only (does not load children) */
  toggleFolder: (path: string) => void;
  /** Toggle folder with hydration (calls toggleFolderHandler if available) */
  toggleFolderWithHydration: (path: string) => Promise<void>;
  expandPath: (path: string) => void;
  collapsePath: (path: string) => void;
  collapseAll: () => void;
  expandToPath: (targetPath: string) => void;
  setExpandedPaths: (paths: Set<string>) => void;
  getExpandedPaths: () => Set<string>;
  isExpanded: (path: string) => boolean;
}

type FileTreeStore = FileTreeState & FileTreeActions;

export const useFileTreeStore = create<FileTreeStore>()((set, get) => ({
  expandedPaths: new Set<string>(),
  workspacePath: null,
  toggleFolderHandler: null,

  initializeExpandedPaths: (workspacePath) => {
    const currentWorkspacePath = get().workspacePath;

    // Save current expanded paths before switching workspace
    if (currentWorkspacePath && currentWorkspacePath !== workspacePath) {
      saveExpandedPaths(currentWorkspacePath, get().expandedPaths);
    }

    // Load expanded paths for new workspace
    const expandedPaths = loadExpandedPaths(workspacePath);
    set({ workspacePath, expandedPaths });
  },

  toggleFolder: (path) => {
    set((state) => {
      const newExpanded = new Set(state.expandedPaths);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }

      // Persist to localStorage
      if (state.workspacePath) {
        saveExpandedPaths(state.workspacePath, newExpanded);
      }

      return { expandedPaths: newExpanded };
    });
  },

  toggleFolderWithHydration: async (path) => {
    const handler = get().toggleFolderHandler;
    if (handler) {
      // Use the injected handler that does hydration
      await handler(path);
    } else {
      // Fallback to simple toggle
      get().toggleFolder(path);
    }
  },

  expandPath: (path) => {
    set((state) => {
      const newExpanded = new Set(state.expandedPaths);
      newExpanded.add(path);

      if (state.workspacePath) {
        saveExpandedPaths(state.workspacePath, newExpanded);
      }

      return { expandedPaths: newExpanded };
    });
  },

  collapsePath: (path) => {
    set((state) => {
      const newExpanded = new Set(state.expandedPaths);
      newExpanded.delete(path);

      if (state.workspacePath) {
        saveExpandedPaths(state.workspacePath, newExpanded);
      }

      return { expandedPaths: newExpanded };
    });
  },

  collapseAll: () => {
    set((state) => {
      const newExpanded = new Set<string>();

      if (state.workspacePath) {
        saveExpandedPaths(state.workspacePath, newExpanded);
      }

      return { expandedPaths: newExpanded };
    });
  },

  expandToPath: (targetPath) => {
    set((state) => {
      const newExpanded = new Set(state.expandedPaths);
      const parts = targetPath.split("/").filter(Boolean);

      // Expand all parent folders leading to the target
      let currentPath = "";
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += `/${parts[i]}`;
        newExpanded.add(currentPath);
      }

      if (state.workspacePath) {
        saveExpandedPaths(state.workspacePath, newExpanded);
      }

      return { expandedPaths: newExpanded };
    });
  },

  setExpandedPaths: (paths) => {
    set((state) => {
      if (state.workspacePath) {
        saveExpandedPaths(state.workspacePath, paths);
      }
      return { expandedPaths: paths };
    });
  },

  getExpandedPaths: () => {
    return get().expandedPaths;
  },

  isExpanded: (path) => {
    return get().expandedPaths.has(path);
  },
}));
