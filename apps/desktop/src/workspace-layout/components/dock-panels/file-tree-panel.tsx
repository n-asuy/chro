import { FileTree } from "@/files/components/file-tree/file-tree";
import { useProjectContext } from "@/files/context/project-context";
import { useActiveWorkspaceScope } from "@/files/hooks/use-active-workspace-scope";
import {
  buildChangedFilesTree,
  collectDirectoryPaths,
} from "@/files/lib/changed-files-tree";
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
import { useDiffStream } from "@/session/hooks";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
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
  const { taskRunId: resolvedScopeTaskRunId, isResolving: isScopeResolving } =
    useActiveWorkspaceScope();

  // While a focused session's runs stream is (re)connecting, the resolved scope
  // transiently reads as null (= project root). Acting on that null loads the
  // full project tree, which flashes for a frame when switching between
  // sessions. Hold the last authoritative scope until the stream resolves so
  // the tree never falls back to the project root mid-switch (keepPreviousData
  // semantics). The ref is updated only on settled (non-resolving) commits, so
  // it always reflects the last known-good scope while resolving.
  const lastResolvedScopeRef = useRef<string | null>(resolvedScopeTaskRunId);
  useEffect(() => {
    if (!isScopeResolving) {
      lastResolvedScopeRef.current = resolvedScopeTaskRunId;
    }
  }, [isScopeResolving, resolvedScopeTaskRunId]);
  const scopeTaskRunId = isScopeResolving
    ? lastResolvedScopeRef.current
    : resolvedScopeTaskRunId;
  // `scopeTaskRunId === null` is overloaded: it means both "settled on the
  // project root" and "scope not yet resolved". While a focused session's runs
  // stream is still resolving and no prior authoritative scope is held (a fresh
  // panel mount, or a project→session switch), the scope is genuinely *unknown*
  // — committing to the project root here loads and flashes the full project
  // tree for a frame before the run's worktree resolves. Treat that window as a
  // distinct third state so project-scoped loads wait for the stream's first
  // snapshot instead of momentarily rendering the whole project.
  const isScopeUnknown = isScopeResolving && scopeTaskRunId === null;
  const initializeExpandedPaths = useFileTreeStore(
    (s) => s.initializeExpandedPaths,
  );
  const expandPath = useFileTreeStore((s) => s.expandPath);
  const replaceExpandedPaths = useFileTreeStore((s) => s.replaceExpandedPaths);
  const fileTree = useFilesStore((s) => s.fileTree);
  const worktreeScopeView = useFilesStore((s) => s.worktreeScopeView);
  const revealRequest = useFilesStore((s) => s.revealRequest);
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);
  const handledRevealTokenRef = useRef(0);

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

  // In session scope the "changed" view shows ONLY the files the agent changed,
  // sourced from the run's diff stream. stats_only keeps it light: we
  // only need the changed paths, not file contents — the session tree is plain
  // (no diff colors), so change kinds aren't needed either. The stream stays
  // subscribed in the "all" view too, so toggling back is instant.
  const { diffs: scopeDiffs } = useDiffStream({
    taskRunId: scopeTaskRunId,
    statsOnly: true,
    enabled: !!scopeTaskRunId,
  });
  const changedPaths = useMemo(() => Object.keys(scopeDiffs), [scopeDiffs]);

  // Build the changed-files-only tree and expand it (including the synthetic
  // root) so every change is visible by default. Expansion is ephemeral
  // (replaceExpandedPaths does not persist), so it never pollutes the project
  // tree's saved state. Skipped in the "all" view, which loads the full
  // worktree listing instead (effect below).
  useEffect(() => {
    if (!scopeTaskRunId || worktreeScopeView !== "changed") return;
    const tree = buildChangedFilesTree(changedPaths);
    setFileTree(tree);
    const expanded = new Set(collectDirectoryPaths(tree));
    if (primaryRoot) expanded.add(primaryRoot.path);
    replaceExpandedPaths(expanded);
  }, [
    scopeTaskRunId,
    worktreeScopeView,
    changedPaths,
    primaryRoot,
    setFileTree,
    replaceExpandedPaths,
  ]);

  // In the "all" view the tree shows the full worktree directory listing — the
  // same entries RPC the project root uses, scoped to the run's worktree. Only
  // the top level loads here; deeper folders hydrate on expand via
  // hydrateDirectory, which already routes through listTaskRunEntries while in
  // scope. Just the synthetic root is expanded so the user drives the rest, and
  // the listing loads once per scope so expanding folders is never reset out
  // from under the user as the agent works.
  useEffect(() => {
    if (!scopeTaskRunId || worktreeScopeView !== "all") return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await listTaskRunEntries(scopeTaskRunId, {
          detail: "basic",
        });
        if (cancelled) return;
        setFileTree(entries.map((e) => entryToFileNode(e)));
        const expanded = new Set<string>();
        if (primaryRoot) expanded.add(primaryRoot.path);
        replaceExpandedPaths(expanded);
      } catch (error) {
        if (cancelled) return;
        console.error(
          "[file-tree-dock-panel] Failed to load worktree entries:",
          error,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    scopeTaskRunId,
    worktreeScopeView,
    primaryRoot,
    setFileTree,
    replaceExpandedPaths,
  ]);

  // While in scope, detach expansion from the persisted project key so folder
  // toggles inside the sandbox stay ephemeral. Leaving scope, the restore
  // effect re-attaches the project's workspace and saved expansion.
  useEffect(() => {
    if (!scopeTaskRunId) return;
    useFileTreeStore.setState({ workspacePath: null });
  }, [scopeTaskRunId]);

  // Before the focused session's scope resolves, neither tree can load: the
  // worktree's changed-files list is not yet known, and loading the project
  // root would flash the full tree — the very content the worktree replaces.
  // Clear any tree left over from a prior project-scoped view so the resolving
  // window renders just the workspace root, not the whole project. Layout
  // effect so a stale tree never paints for a frame before it is cleared.
  useLayoutEffect(() => {
    if (!isScopeUnknown) return;
    setFileTree([]);
  }, [isScopeUnknown, setFileTree]);

  // Expanded-folder state lives in persisted UI state, which hydrates
  // asynchronously after first paint (loadUiState() in main.tsx). Until it
  // is ready, loadExpandedPaths() returns an empty set; initializing then
  // would both lose the user's folders and overwrite the saved state with
  // an empty/root-only set. Wait for readiness — mirroring the polling used
  // by open-projects and recent-workspaces hydration — before initializing,
  // then re-assert the always-expanded primary root so the freshly loaded
  // set keeps it open (covers a workspace's first-ever open).
  useEffect(() => {
    // Session scope manages its own ephemeral expand-all, and an unresolved
    // scope must not commit to the project either; in both cases skip the
    // persisted project expansion so it is not clobbered or flashed. Settling
    // on the project root re-runs this and restores the saved set.
    if (scopeTaskRunId || isScopeUnknown) return;
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
  }, [
    workspacePath,
    primaryRoot,
    initializeExpandedPaths,
    expandPath,
    scopeTaskRunId,
    isScopeUnknown,
  ]);

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

  // Load the full project root listing. In session scope the tree is driven by
  // the changed-files effect above instead; while the scope is still resolving
  // we also wait, so the project tree never flashes before the worktree
  // resolves. Both cases skip this load.
  useEffect(() => {
    if (scopeTaskRunId || isScopeUnknown) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!projectId) return;
        const entries = await listProjectEntries(projectId, {
          detail: "basic",
        });
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
  }, [projectId, scopeTaskRunId, isScopeUnknown, setFileTree]);

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

  // Expand + hydrate every ancestor of a reveal target (e.g. a skill folder
  // opened from the Skills panel) so its row exists in the tree; the leaf is
  // expanded too, surfacing the package's files. hydrateDirectory awaits each
  // level before descending, so the next-deeper node is present before it is
  // hydrated. The FileTree view handles scrolling the row into view.
  const revealInTree = useCallback(
    async (targetPath: string) => {
      if (!targetPath || targetPath === "/") return;
      const treeState = useFileTreeStore.getState();
      treeState.expandPath("/");
      const parts = targetPath.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur += `/${part}`;
        await hydrateDirectory(cur);
        useFileTreeStore.getState().expandPath(cur);
      }
    },
    [hydrateDirectory],
  );

  useEffect(() => {
    if (!projectId || scopeTaskRunId) return;
    if (!revealRequest) return;
    if (revealRequest.token === handledRevealTokenRef.current) return;
    handledRevealTokenRef.current = revealRequest.token;
    void revealInTree(revealRequest.path);
  }, [projectId, scopeTaskRunId, revealRequest, revealInTree]);

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
