import {
  type ProjectFileEvent,
  listProjectEntries,
  subscribeProjectFileEvents,
} from "@/lib/project-client";
import { WORKSPACE_REFRESH_EVENT } from "@/lib/preferences-events";
import { recordPerfEvent, startPerfTimer } from "@/perf/recorder";
import { AppRail } from "@/sidebar/app-rail";
import { AppRailProvider } from "@/sidebar/app-rail-context";
import { ElectronTitlebar } from "@/window/electron-titlebar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getUiValue, setUiValue } from "@/lib/ui-state-client";
import { useProjectContext } from "../context/project-context";
import { useFileUrlSync } from "../hooks/use-file-url-sync";
import { entryToFileNode } from "../lib/workspace-tree";
import { useFileTreeStore } from "../state/file-tree-store";
import { useFilesStore } from "../state/files-store";
import {
  type FileNode,
  FileNodeType,
  findNodeByPath,
  getDisplayName,
} from "../types/file-tree";
import { FilesEditor } from "./editor/files-editor";
import { FilesCommandPalette } from "./files-command-palette";
import { FilesPathHeader } from "./files-path-header";
import { FilesRightPanel } from "./files-right-panel";
import { FilesSidebar } from "./files-sidebar";

const PRELOAD_MAX_DEPTH = 2;
const PRELOAD_MAX_DIRS = 80;
const FILES_SIDEBAR_COLLAPSED_KEY = "files-sidebar-collapsed";
const FILES_RIGHT_PANEL_COLLAPSED_KEY = "files-right-panel-collapsed";
const DIRECTORY_REFRESH_DEBOUNCE_MS = 300;

// Pending directory refreshes (for debouncing)
const pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

const countTreeNodes = (nodes: FileNode[]): number => {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    count += 1;
    if (node.children && node.children.length > 0) {
      stack.push(...node.children);
    }
  }
  return count;
};

export const FilesShell = () => {
  const {
    fileTree,
    setFileTree,
    setRootPath,
    setProjectId,
    updateNode,
    updateNodes,
  } = useFilesStore();

  const { expandedPaths, initializeExpandedPaths } = useFileTreeStore();

  const {
    projectId,
    workspacePath,
    isLoading: projectLoading,
    error: projectError,
  } = useProjectContext();

  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => getUiValue<boolean>(FILES_SIDEBAR_COLLAPSED_KEY) ?? false,
  );
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(
    () => getUiValue<boolean>(FILES_RIGHT_PANEL_COLLAPSED_KEY) ?? false,
  );
  const [isInitialMount, setIsInitialMount] = useState(true);
  const pendingModifiedNotificationsRef =
    useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setUiValue(FILES_SIDEBAR_COLLAPSED_KEY, sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    setUiValue(FILES_RIGHT_PANEL_COLLAPSED_KEY, rightPanelCollapsed);
  }, [rightPanelCollapsed]);

  // Load root entries only (instant display)
  const loadRootEntries = useCallback(async () => {
    if (!projectId) return;
    const finishRootLoadTimer = startPerfTimer("workspace_tree_root_load", {
      project_id: projectId,
    });

    // Load only root level - no recursive
    try {
      const entries = await listProjectEntries(projectId, { detail: "basic" });
      setRootPath("/");
      setFileTree(entries.map(entryToFileNode));
      finishRootLoadTimer({
        outcome: "ok",
        root_entries: entries.length,
      });
      return entries.length;
    } catch (error) {
      finishRootLoadTimer({
        outcome: "error",
        error:
          error instanceof Error ? error.message : "root_entries_load_failed",
      });
      throw error;
    }
  }, [projectId, setFileTree, setRootPath]);

  // Load children for a single directory (on-demand when expanding)
  const hydrateDirectory = useCallback(
    async (path: string): Promise<FileNode[]> => {
      if (!projectId || !path) return [];

      const node = findNodeByPath(useFilesStore.getState().fileTree, path);
      if (!node || node.type !== FileNodeType.Directory) return [];

      // Already hydrated or currently hydrating
      if (node.isHydrated || node.isHydrating) {
        return node.children ?? [];
      }

      // Mark as hydrating
      updateNode(path, { isHydrating: true });

      try {
        const relativePath = node.relativePath ?? path.replace(/^\/+/, "");
        const entries = await listProjectEntries(projectId, {
          relativePath: relativePath || undefined,
          detail: "basic",
        });
        const childNodes = entries.map(entryToFileNode);

        updateNode(path, {
          children: childNodes,
          hasChildren: childNodes.length > 0,
          isHydrated: true,
          isHydrating: false,
        });

        return childNodes;
      } catch (error) {
        console.error(
          "[files-shell] Failed to hydrate directory:",
          path,
          error,
        );
        updateNode(path, { isHydrating: false });
        return [];
      }
    },
    [projectId, updateNode],
  );

  /**
   * Refresh a directory's contents from the backend.
   * Only refreshes if the directory is expanded (or is root).
   */
  const refreshDirectory = useCallback(
    async (dirPath: string) => {
      if (!projectId) return;

      const state = useFilesStore.getState();
      const treeState = useFileTreeStore.getState();

      // Check if directory exists in tree
      const dirNode = findNodeByPath(state.fileTree, dirPath);
      if (!dirNode || dirNode.type !== FileNodeType.Directory) return;

      // Only refresh if expanded or is root
      const isRoot = dirPath === "/";
      const isExpanded = isRoot || treeState.isExpanded(dirPath);
      if (!isExpanded) return;

      try {
        const relativePath =
          dirNode.relativePath ?? dirPath.replace(/^\/+/, "");
        const entries = await listProjectEntries(projectId, {
          relativePath: relativePath || undefined,
          detail: "basic",
        });
        const childNodes = entries.map(entryToFileNode);

        updateNode(dirPath, {
          children: childNodes,
          hasChildren: childNodes.length > 0,
          isHydrated: true,
          isHydrating: false,
        });
      } catch (error) {
        console.error(
          "[files-shell] Failed to refresh directory:",
          dirPath,
          error,
        );
      }
    },
    [projectId, updateNode],
  );

  /**
   * Schedule a debounced directory refresh.
   * Multiple calls for the same directory within DIRECTORY_REFRESH_DEBOUNCE_MS
   * will be consolidated into a single refresh.
   */
  const scheduleDirectoryRefresh = useCallback(
    (dirPath: string) => {
      const existing = pendingRefreshes.get(dirPath);
      if (existing) {
        clearTimeout(existing);
      }

      pendingRefreshes.set(
        dirPath,
        setTimeout(() => {
          pendingRefreshes.delete(dirPath);
          void refreshDirectory(dirPath);
        }, DIRECTORY_REFRESH_DEBOUNCE_MS),
      );
    },
    [refreshDirectory],
  );

  // Preload subtree children up to a depth and directory budget (background)
  const preloadSubtree = useCallback(
    async (
      rootPath: string,
      maxDepth = PRELOAD_MAX_DEPTH,
      maxDirs = PRELOAD_MAX_DIRS,
    ) => {
      if (!projectId) return;

      const visited = new Set<string>();
      type QueueItem = { path: string; depth: number };
      const queue: QueueItem[] = [{ path: rootPath, depth: 0 }];
      let processed = 0;

      while (queue.length > 0 && processed < maxDirs) {
        // Process in batches of 8 for parallelism
        const batch = queue.splice(0, 8);

        await Promise.all(
          batch.map(async (item) => {
            if (visited.has(item.path) || item.depth >= maxDepth) return;
            visited.add(item.path);
            processed++;

            try {
              const node = findNodeByPath(
                useFilesStore.getState().fileTree,
                item.path,
              );
              if (!node || node.type !== FileNodeType.Directory) return;

              // If already has children, just enqueue subdirs
              if (
                node.children &&
                node.children.length > 0 &&
                node.isHydrated
              ) {
                for (const child of node.children) {
                  if (child.type !== FileNodeType.Directory) continue;
                  queue.push({ path: child.path, depth: item.depth + 1 });
                }
                return;
              }

              // Load children
              const relativePath =
                node.relativePath ?? item.path.replace(/^\/+/, "");
              const entries = await listProjectEntries(projectId, {
                relativePath: relativePath || undefined,
                detail: "basic",
              });
              const childNodes = entries.map(entryToFileNode);

              updateNode(item.path, {
                children: childNodes,
                hasChildren: childNodes.length > 0,
                isHydrated: true,
                isHydrating: false,
              });

              // Enqueue subdirs for next iteration
              for (const child of childNodes) {
                if (child.type !== FileNodeType.Directory) continue;
                queue.push({ path: child.path, depth: item.depth + 1 });
              }
            } catch {
              // Silently ignore errors in preload
            }
          }),
        );

        // Yield to UI
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    [projectId, updateNode],
  );

  // Toggle folder expansion while preserving hydrated tree state.
  const toggleFolder = useCallback(
    async (path: string) => {
      const uiStore = useFileTreeStore.getState();
      const isCurrentlyExpanded = uiStore.expandedPaths.has(path);

      if (!isCurrentlyExpanded) {
        // Expand: load children if not present
        const node = findNodeByPath(useFilesStore.getState().fileTree, path);
        if (node && node.type === FileNodeType.Directory) {
          if (
            !node.children ||
            node.children.length === 0 ||
            !node.isHydrated
          ) {
            await hydrateDirectory(path);
          }
        }
        uiStore.expandPath(path);

        // Preload deeper children in background for snappier navigation
        preloadSubtree(path, PRELOAD_MAX_DEPTH, PRELOAD_MAX_DIRS).catch(
          () => {},
        );
      } else {
        // Collapse: only toggle UI state; keep children cached
        uiStore.collapsePath(path);
      }
    },
    [hydrateDirectory, preloadSubtree],
  );

  // Expose toggleFolder to file-tree-store for use in file-tree component
  useEffect(() => {
    useFileTreeStore.setState({ toggleFolderHandler: toggleFolder });
  }, [toggleFolder]);

  // Hydrate all saved expanded paths at once (batch update for instant display)
  const hydrateExpandedPaths = useCallback(async () => {
    if (!projectId) return;

    const savedExpandedPaths = useFileTreeStore.getState().expandedPaths;
    if (savedExpandedPaths.size === 0) return;

    // Sort by depth (parents first) to ensure proper hydration order
    const sortedPaths = Array.from(savedExpandedPaths)
      .filter((p) => p !== "/")
      .sort((a, b) => a.split("/").length - b.split("/").length);

    // Collect all updates without triggering UI updates
    const allUpdates = new Map<string, Partial<FileNode>>();

    // Fetch all directory contents in parallel batches
    const BATCH_SIZE = 8;
    for (let i = 0; i < sortedPaths.length; i += BATCH_SIZE) {
      const batch = sortedPaths.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (path) => {
          // Need to get current tree state for each iteration since we're building up children
          const currentTree = useFilesStore.getState().fileTree;
          // Apply pending updates to find node correctly
          const findNodeWithUpdates = (
            nodes: FileNode[],
            targetPath: string,
          ): FileNode | null => {
            for (const node of nodes) {
              const pendingUpdate = allUpdates.get(node.path);
              const mergedNode = pendingUpdate
                ? { ...node, ...pendingUpdate }
                : node;
              if (mergedNode.path === targetPath) {
                return mergedNode;
              }
              const children = mergedNode.children ?? node.children;
              if (children) {
                const found = findNodeWithUpdates(children, targetPath);
                if (found) return found;
              }
            }
            return null;
          };

          const node = findNodeWithUpdates(currentTree, path);
          if (!node || node.type !== FileNodeType.Directory) return;
          if (node.isHydrated) return;

          try {
            const relativePath = node.relativePath ?? path.replace(/^\/+/, "");
            const entries = await listProjectEntries(projectId, {
              relativePath: relativePath || undefined,
              detail: "basic",
            });
            const childNodes = entries.map(entryToFileNode);

            allUpdates.set(path, {
              children: childNodes,
              hasChildren: childNodes.length > 0,
              isHydrated: true,
              isHydrating: false,
            });
          } catch {
            // Silently ignore errors
          }
        }),
      );
    }

    // Apply all updates at once
    if (allUpdates.size > 0) {
      updateNodes(allUpdates);
    }
  }, [projectId, updateNodes]);

  // Sync projectId to vault-store
  useEffect(() => {
    setProjectId(projectId);
  }, [projectId, setProjectId]);

  // Initialize workspace when project is loaded
  useEffect(() => {
    if (!projectId || !workspacePath || projectLoading) return;

    const finishWorkspaceInitTimer = startPerfTimer(
      "workspace_tree_initialization",
      {
        project_id: projectId,
        workspace_path: workspacePath,
      },
    );

    setWorkspaceLoading(true);
    setWorkspaceError(null);

    // Get current workspace path to check if it changed
    const currentWorkspacePath = useFileTreeStore.getState().workspacePath;
    const isWorkspaceChanged = currentWorkspacePath !== workspacePath;

    if (isInitialMount || isWorkspaceChanged) {
      initializeExpandedPaths(workspacePath);
      if (isInitialMount) {
        setIsInitialMount(false);
      }
    }

    loadRootEntries()
      .then(async (rootEntriesCount) => {
        // After root loads, hydrate all saved expanded paths to restore state
        await hydrateExpandedPaths();
        // Then preload first 2 levels in background
        preloadSubtree("/", PRELOAD_MAX_DEPTH, PRELOAD_MAX_DIRS).catch(
          () => {},
        );
        const treeState = useFilesStore.getState().fileTree;
        const totalNodes = countTreeNodes(treeState);
        const expandedPathsCount =
          useFileTreeStore.getState().expandedPaths.size;
        recordPerfEvent("workspace_tree_ready", {
          project_id: projectId,
          workspace_path: workspacePath,
          root_entries: rootEntriesCount ?? null,
          total_nodes: totalNodes,
          expanded_paths: expandedPathsCount,
        });
        finishWorkspaceInitTimer({
          outcome: "ok",
          root_entries: rootEntriesCount ?? null,
          total_nodes: totalNodes,
          expanded_paths: expandedPathsCount,
        });
      })
      .catch((error) => {
        console.error("[files] Failed to load workspace", error);
        finishWorkspaceInitTimer({
          outcome: "error",
          error:
            error instanceof Error
              ? error.message
              : "workspace_initialization_failed",
        });
        setWorkspaceError(
          error instanceof Error ? error.message : "Failed to load workspace",
        );
      })
      .finally(() => {
        setWorkspaceLoading(false);
      });
  }, [
    projectId,
    workspacePath,
    projectLoading,
    loadRootEntries,
    initializeExpandedPaths,
    isInitialMount,
    preloadSubtree,
    hydrateExpandedPaths,
  ]);

  // Ref to hold the latest scheduleDirectoryRefresh function
  // This prevents WebSocket re-subscription when the function reference changes
  const scheduleDirectoryRefreshRef = useRef(scheduleDirectoryRefresh);
  scheduleDirectoryRefreshRef.current = scheduleDirectoryRefresh;

  // Handle real-time file change events
  // Using useRef pattern to prevent WebSocket re-subscription loop
  const handleFileEventRef = useRef((event: ProjectFileEvent) => {
    const { event_type, relative_path } = event;
    const fullPath = `/${relative_path}`;
    const parentPath = relative_path.includes("/")
      ? `/${relative_path.substring(0, relative_path.lastIndexOf("/"))}`
      : "/";

    // Get current state directly from store
    const state = useFilesStore.getState();

    switch (event_type) {
      case "created": {
        // Skip if we're in editing mode for this path (we created it ourselves)
        if (state.editingPath === fullPath) return;

        // Check if node already exists (avoid duplicates from our own actions)
        const existingNode = findNodeByPath(state.fileTree, fullPath);
        if (existingNode) return;

        // Schedule parent directory refresh (debounced)
        scheduleDirectoryRefreshRef.current(parentPath);
        break;
      }
      case "deleted": {
        // Schedule parent directory refresh (debounced)
        scheduleDirectoryRefreshRef.current(parentPath);
        break;
      }
      case "modified": {
        // File content modified - update metadata in tree
        state.updateNode(fullPath, {
          metadata: {
            modified: new Date(),
          },
        });
        const timers = pendingModifiedNotificationsRef.current;
        const existing = timers.get(fullPath);
        if (existing) {
          clearTimeout(existing);
        }
        const timer = setTimeout(() => {
          useFilesStore.getState().notifyFileModified(fullPath);
          timers.delete(fullPath);
        }, 180);
        timers.set(fullPath, timer);
        break;
      }
      case "renamed": {
        // Renamed events trigger both old parent and new parent refresh
        // For now, refresh the parent of the new path
        scheduleDirectoryRefreshRef.current(parentPath);
        break;
      }
    }
  });

  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = subscribeProjectFileEvents(
      projectId,
      handleFileEventRef.current,
    );
    return () => {
      unsubscribe();
      const timers = pendingModifiedNotificationsRef.current;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, [projectId]); // Only re-subscribe when projectId changes

  // Reload file tree when preferences change (e.g. show/hide hidden files)
  useEffect(() => {
    const handler = () => {
      // Reset hydration flags so directories are re-fetched from backend
      const tree = useFilesStore.getState().fileTree;
      const resetUpdates = new Map<string, Partial<FileNode>>();
      const collectDirs = (nodes: FileNode[]) => {
        for (const node of nodes) {
          if (node.type === FileNodeType.Directory) {
            resetUpdates.set(node.path, { isHydrated: false });
            if (node.children) collectDirs(node.children);
          }
        }
      };
      collectDirs(tree);
      if (resetUpdates.size > 0) updateNodes(resetUpdates);

      loadRootEntries()
        .then(() => hydrateExpandedPaths())
        .catch((err) =>
          console.error("[files-shell] workspace refresh failed:", err),
        );
    };
    window.addEventListener(WORKSPACE_REFRESH_EVENT, handler);
    return () => window.removeEventListener(WORKSPACE_REFRESH_EVENT, handler);
  }, [loadRootEntries, hydrateExpandedPaths, updateNodes]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const handleToggleRightPanel = useCallback(() => {
    setRightPanelCollapsed((prev) => !prev);
  }, []);

  const isLoading = projectLoading || workspaceLoading;
  const error = projectError ?? workspaceError;

  // Sync file path with URL query parameter
  useFileUrlSync();

  const workspaceGate = useMemo(() => {
    if (!projectId) {
      return (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 border border-dashed border-custom-border-200 bg-custom-background-100/95 text-center text-custom-text-200">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-custom-text-100">
              No project selected
            </h2>
            <p className="text-sm text-custom-text-300">
              Navigate to a project to view its files.
            </p>
            {error && <p className="text-sm text-custom-text-300">{error}</p>}
          </div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 border border-dashed border-custom-border-200 bg-custom-background-100/95 text-center text-custom-text-200">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-custom-text-100">
              Error loading workspace
            </h2>
          </div>
        </div>
      );
    }

    return null;
  }, [error, projectId]);

  return (
    <AppRailProvider>
      <div
        className="flex h-screen w-full bg-custom-background-90 text-custom-text-100 font-sans antialiased overflow-hidden"
      >
        <ElectronTitlebar />
        <FilesCommandPalette />
        <AppRail />

        <div className="flex flex-col flex-1 min-w-0 h-full relative">
          <div className="flex-1 mr-2 mb-2 mt-2 ml-2 relative z-10 bg-custom-background-100 rounded-lg shadow-sm border border-custom-border-200 overflow-hidden">
            <div className="relative flex h-full w-full flex-col overflow-hidden">
              <div
                id="full-screen-portal"
                className="absolute inset-0 w-full"
              />
              <div className="relative flex size-full overflow-hidden">
                <FilesSidebar
                  collapsed={sidebarCollapsed}
                  onToggle={handleToggleSidebar}
                />
                <main className="relative flex h-full w-full flex-col overflow-hidden">
                  <FilesPathHeader
                    isSidebarCollapsed={sidebarCollapsed}
                    isRightPanelCollapsed={rightPanelCollapsed}
                    onOpenSidebar={handleToggleSidebar}
                    onOpenRightPanel={handleToggleRightPanel}
                  />
                  {workspaceGate}
                  <div className="flex h-full flex-1 overflow-hidden">
                    <FilesEditor />
                  </div>
                </main>
                <FilesRightPanel
                  collapsed={rightPanelCollapsed}
                  onToggle={handleToggleRightPanel}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppRailProvider>
  );
};
