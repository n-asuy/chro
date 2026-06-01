import { FileTree } from "@/files/components/file-tree/file-tree";
import { useProjectContext } from "@/files/context/project-context";
import { useActiveWorkspaceScope } from "@/files/hooks/use-active-workspace-scope";
import { entryToFileNode } from "@/files/lib/workspace-tree";
import {
  type PersistedWorktree,
  loadProjectWorktrees,
  saveProjectWorktrees,
} from "@/files/lib/worktree-persistence";
import { useFileTreeStore } from "@/files/state/file-tree-store";
import { type WorkspaceRoot, useFilesStore } from "@/files/state/files-store";
import { FileNodeType, findNodeByPath } from "@/files/types/file-tree";
import {
  listProjectEntries,
  listTaskRunEntries,
  listWorkspaceEntriesAtPath,
  subscribeProjectFileEvents,
} from "@/lib/project-client";
import { isUiStateReady } from "@/lib/ui-state-client";
import { useCallback, useEffect, useMemo } from "react";
import { useDockCloseHandler } from "../dock-store-context";

const deriveRootName = (
  workspacePath: string | null,
  projectName: string | null | undefined,
): string => {
  if (projectName && projectName.trim().length > 0) return projectName;
  if (workspacePath) {
    const trimmed = workspacePath.replace(/[\\/]+$/, "");
    const segments = trimmed.split(/[\\/]/).filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) return last;
  }
  return "Workspace";
};

const deriveAdHocRootName = (absolutePath: string): string => {
  const trimmed = absolutePath.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? absolutePath;
};

/**
 * Find which workspace root owns a given node path. The primary root has
 * `path: "/"` (matches everything), so we prefer the longest non-primary
 * absolute-path prefix and fall back to primary otherwise. Returns null
 * when there are no roots (e.g. before project load).
 */
const findOwningRoot = (
  path: string,
  roots: WorkspaceRoot[],
): WorkspaceRoot | null => {
  let best: WorkspaceRoot | null = null;
  for (const r of roots) {
    if (r.isPrimary) continue;
    if (path === r.path || path.startsWith(`${r.path}/`)) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  if (best) return best;
  return roots.find((r) => r.isPrimary) ?? null;
};

/**
 * LeftDock panel hosting the project file tree. Owns root-entry load and
 * directory hydration handler. The FileTree component itself reads its
 * data from `useFilesStore`, so this panel is thin: it just wires the
 * loaders and renders.
 */
export function FileTreeDockPanel() {
  const { projectId, workspacePath, project } = useProjectContext();
  const setFileTree = useFilesStore((s) => s.setFileTree);
  const setRoots = useFilesStore((s) => s.setRoots);
  const setRootChildren = useFilesStore((s) => s.setRootChildren);
  const setProjectId = useFilesStore((s) => s.setProjectId);
  const setScopeTaskRunId = useFilesStore((s) => s.setScopeTaskRunId);
  const updateNode = useFilesStore((s) => s.updateNode);
  // When a session sandbox is in view, the tree roots at that run's worktree
  // instead of the project checkout. Null falls back to the project root
  // (new sessions, local runs, project-level surfaces).
  const { taskRunId: scopeTaskRunId } = useActiveWorkspaceScope();
  const initializeExpandedPaths = useFileTreeStore(
    (s) => s.initializeExpandedPaths,
  );
  const expandPath = useFileTreeStore((s) => s.expandPath);
  const fileTree = useFilesStore((s) => s.fileTree);
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);

  const primaryRoot = useMemo<WorkspaceRoot | null>(() => {
    if (!projectId) return null;
    const name = deriveRootName(workspacePath, project?.name ?? null);
    return { path: "/", name, displayName: name, isPrimary: true };
  }, [projectId, workspacePath, project?.name]);

  // Sync project id into the files store for downstream consumers
  useEffect(() => {
    setProjectId(projectId);
  }, [projectId, setProjectId]);

  // Publish the active scope so file opens route through the run's worktree
  // and the tree disables project-scoped mutations while a sandbox is shown.
  useEffect(() => {
    setScopeTaskRunId(scopeTaskRunId);
  }, [scopeTaskRunId, setScopeTaskRunId]);

  // Clear the scope when the panel unmounts (right dock collapsed or switched
  // away). Otherwise a stale worktree scope would linger and mis-route file
  // opens triggered from other surfaces while the tree is not visible.
  useEffect(() => {
    return () => setScopeTaskRunId(null);
  }, [setScopeTaskRunId]);

  // Expanded-folder state lives in persisted UI state, which hydrates
  // asynchronously after first paint (loadUiState() in main.tsx). Until it
  // is ready, loadExpandedPaths() returns an empty set; initializing then
  // would both lose the user's folders and overwrite the saved state with
  // an empty/root-only set. Wait for readiness — mirroring the polling used
  // by open-projects and recent-workspaces hydration — before initializing,
  // then re-assert the always-expanded primary root so the freshly loaded
  // set keeps it open (covers a workspace's first-ever open).
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      initializeExpandedPaths(workspacePath);
      if (primaryRoot) expandPath(primaryRoot.path);
    };
    if (isUiStateReady()) {
      run();
      return;
    }
    const id = window.setInterval(() => {
      if (isUiStateReady()) {
        window.clearInterval(id);
        run();
      }
    }, 50);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [workspacePath, primaryRoot, initializeExpandedPaths, expandPath]);

  // Initialize roots when the bound project changes. The primary root is
  // always present; persisted ad-hoc worktrees (added previously via
  // "Add Folder to Project") are restored from ui-state and re-attached.
  useEffect(() => {
    if (!primaryRoot) {
      setRoots([]);
      return;
    }
    const persisted: PersistedWorktree[] = projectId
      ? loadProjectWorktrees(projectId)
      : [];
    const adHoc: WorkspaceRoot[] = persisted.map((w) => ({
      path: w.absolutePath,
      name: w.displayName ?? deriveAdHocRootName(w.absolutePath),
      displayName: w.displayName ?? deriveAdHocRootName(w.absolutePath),
      isPrimary: false,
      children: [],
    }));
    setRoots([primaryRoot, ...adHoc]);
    // Primary-root expansion is asserted by the ui-state-gated effect above,
    // so it survives the asynchronously-loaded expanded-path set.
  }, [primaryRoot, projectId, setRoots]);

  // When ad-hoc roots are present, hydrate their root-level children from
  // the filesystem. Skipped for the primary root (which uses fileTree).
  // Subscribes via getState() so it doesn't depend on the roots array.
  const roots = useFilesStore((s) => s.roots);
  useEffect(() => {
    let cancelled = false;
    for (const root of roots) {
      if (root.isPrimary) continue;
      if (root.children && root.children.length > 0) continue;
      void (async () => {
        try {
          const entries = await listWorkspaceEntriesAtPath(root.path, {
            detail: "basic",
          });
          if (cancelled) return;
          setRootChildren(
            root.path,
            entries.map((e) => entryToFileNode(e, root.path)),
          );
        } catch (error) {
          if (cancelled) return;
          console.error(
            "[file-tree-dock-panel] Failed to hydrate ad-hoc root:",
            root.path,
            error,
          );
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [roots, setRootChildren]);

  // Persist ad-hoc roots whenever the list changes so they survive reloads.
  useEffect(() => {
    if (!projectId) return;
    const adHoc = roots
      .filter((r) => !r.isPrimary)
      .map<PersistedWorktree>((r) => ({
        absolutePath: r.path,
        displayName: r.displayName,
      }));
    saveProjectWorktrees(projectId, adHoc);
  }, [projectId, roots]);

  // Load root entries when the project or active scope changes. In worktree
  // scope the entries come from the run's sandbox; otherwise the project root.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let entries: Awaited<ReturnType<typeof listProjectEntries>>;
        if (scopeTaskRunId) {
          entries = await listTaskRunEntries(scopeTaskRunId, {
            detail: "basic",
          });
        } else if (projectId) {
          entries = await listProjectEntries(projectId, { detail: "basic" });
        } else {
          return;
        }
        if (cancelled) return;
        setFileTree(entries.map((e) => entryToFileNode(e)));
      } catch (error) {
        if (cancelled) return;
        console.error(
          "[file-tree-dock-panel] Failed to load root entries:",
          error,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, scopeTaskRunId, setFileTree]);

  // Fetch and attach a directory's children when they have not been loaded
  // yet. Pure hydration: it never touches expansion state, so the same
  // routine serves both user-driven toggles and the restore-on-reload effect
  // below. No-op for the synthetic root header (its children come from the
  // primary file-tree load or the ad-hoc root hydration effect), for
  // non-directory nodes, and for directories already hydrated or in flight.
  // Dispatches on the owning root so ad-hoc workspace folders ("Add Folder
  // to Project") use the absolute-path filesystem RPC, while the primary
  // root keeps using the project-scoped entries RPC.
  const hydrateDirectory = useCallback(
    async (path: string) => {
      const filesState = useFilesStore.getState();
      const owningRoot = findOwningRoot(path, filesState.roots);

      if (owningRoot && owningRoot.path === path) return;

      const containerTree =
        owningRoot && !owningRoot.isPrimary
          ? owningRoot.children ?? []
          : filesState.fileTree;
      const node = findNodeByPath(containerTree, path);
      if (!node || node.type !== FileNodeType.Directory) return;
      if (node.isHydrated || node.isHydrating) return;

      updateNode(path, { isHydrating: true });
      try {
        const relativePath = node.relativePath ?? "";
        let entries: Awaited<ReturnType<typeof listProjectEntries>> = [];
        if (owningRoot && !owningRoot.isPrimary) {
          entries = await listWorkspaceEntriesAtPath(owningRoot.path, {
            relativePath: relativePath || undefined,
            detail: "basic",
          });
        } else if (scopeTaskRunId) {
          entries = await listTaskRunEntries(scopeTaskRunId, {
            relativePath: relativePath || undefined,
            detail: "basic",
          });
        } else if (projectId) {
          entries = await listProjectEntries(projectId, {
            relativePath: relativePath || undefined,
            detail: "basic",
          });
        }
        const rootPrefix = owningRoot?.isPrimary
          ? "/"
          : owningRoot?.path ?? "/";
        updateNode(path, {
          children: entries.map((e) => entryToFileNode(e, rootPrefix)),
          hasChildren: entries.length > 0,
          isHydrated: true,
          isHydrating: false,
        });
      } catch (error) {
        console.error(
          "[file-tree-dock-panel] Failed to hydrate directory:",
          path,
          error,
        );
        updateNode(path, { isHydrating: false });
      }
    },
    [projectId, scopeTaskRunId, updateNode],
  );

  // Toggle a folder: collapse if open, otherwise hydrate its children (if
  // needed) and expand. The FileTree component calls this via
  // useFileTreeStore.toggleFolderWithHydration → toggleFolderHandler.
  const toggleFolder = useCallback(
    async (path: string) => {
      if (!path) return;
      const treeState = useFileTreeStore.getState();
      if (treeState.expandedPaths.has(path)) {
        treeState.collapsePath(path);
        return;
      }
      await hydrateDirectory(path);
      useFileTreeStore.getState().expandPath(path);
    },
    [hydrateDirectory],
  );

  useEffect(() => {
    useFileTreeStore.setState({ toggleFolderHandler: toggleFolder });
    return () => {
      useFileTreeStore.setState({ toggleFolderHandler: null });
    };
  }, [toggleFolder]);

  // Restore persisted expansions after a reload. The expanded-path set is
  // rehydrated from ui-state, but nested directory children are otherwise
  // only fetched on user click — so without this, restored expansions would
  // render empty. Hydrate every expanded-but-unloaded directory; hydrating a
  // parent reveals its children, which lets the next-deeper expanded
  // directory hydrate on the following pass. The cascade converges once all
  // expanded directories are loaded (hydrateDirectory is idempotent, so
  // already-loaded or in-flight directories are skipped without re-fetching).
  useEffect(() => {
    if (!projectId) return;
    for (const path of Array.from(expandedPaths)) {
      void hydrateDirectory(path);
    }
  }, [projectId, expandedPaths, fileTree, roots, hydrateDirectory]);

  // openTab bridge moved to LayoutShell so file path clicks work even when
  // this dock panel is not the active panel (e.g. session-only views).

  // Refresh tree on backend-emitted file change events. Debounced per
  // parent directory to coalesce bursts. Skipped in worktree scope: the
  // project file-events stream watches the project checkout, so refreshing
  // from it would overwrite the sandbox tree with project entries.
  useEffect(() => {
    if (!projectId || scopeTaskRunId) return;
    const debouncers = new Map<string, ReturnType<typeof setTimeout>>();
    const refreshDir = async (parentPath: string) => {
      const node = findNodeByPath(
        useFilesStore.getState().fileTree,
        parentPath,
      );
      if (!node || node.type !== FileNodeType.Directory) return;
      try {
        const relativePath =
          node.relativePath ?? parentPath.replace(/^\/+/, "");
        const entries = await listProjectEntries(projectId, {
          relativePath: relativePath || undefined,
          detail: "basic",
        });
        useFilesStore.getState().updateNode(parentPath, {
          children: entries.map((e) => entryToFileNode(e)),
          hasChildren: entries.length > 0,
          isHydrated: true,
          isHydrating: false,
        });
      } catch {
        // ignore transient errors
      }
    };
    const schedule = (parentPath: string) => {
      const existing = debouncers.get(parentPath);
      if (existing) clearTimeout(existing);
      debouncers.set(
        parentPath,
        setTimeout(() => {
          debouncers.delete(parentPath);
          void refreshDir(parentPath);
        }, 300),
      );
    };
    const unsubscribe = subscribeProjectFileEvents(projectId, (event) => {
      const { event_type, relative_path } = event;
      const parentPath = relative_path.includes("/")
        ? `/${relative_path.substring(0, relative_path.lastIndexOf("/"))}`
        : "/";
      switch (event_type) {
        case "created":
        case "deleted":
        case "renamed":
          schedule(parentPath);
          break;
        case "modified": {
          const fullPath = `/${relative_path}`;
          useFilesStore.getState().updateNode(fullPath, {
            metadata: { modified: new Date() },
          });
          break;
        }
      }
    });
    return () => {
      unsubscribe();
      for (const t of debouncers.values()) clearTimeout(t);
      debouncers.clear();
    };
  }, [projectId, scopeTaskRunId]);

  const handleClose = useDockCloseHandler();

  return (
    <div className="h-full w-full">
      <FileTree onClose={handleClose} />
    </div>
  );
}
