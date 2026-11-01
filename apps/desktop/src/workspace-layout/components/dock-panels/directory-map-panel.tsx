import { TreeNode } from "@/files/components/file-tree/tree-node";
import { useFileTreeDnd } from "@/files/hooks/use-file-tree-dnd";
import {
  type FileNode,
  FileNodeType,
  getDisplayName,
} from "@/files/types/file-tree";
import type { TranslationFunction } from "@/i18n";
import {
  fetchProjectTree,
  subscribeProjectTree,
} from "@/lib/directory-map-client";
import { SessionActivityIndicator } from "@/session/components/session-activity-indicator";
import type { StoredTask } from "@/session/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  type DirectoryMapSortMode,
  type DirectoryTreeNode,
  ancestorDirectories,
  buildDirectoryTree,
  compactDirectoryChain,
  directoryLastActivity,
  parentDirectory,
} from "../../domain/directory-tree";
import { useProjectNavigation } from "../../hooks/use-project-navigation";
import {
  EMPTY_MAP_PROJECT,
  useDirectoryMapStore,
} from "../../state/directory-map-store";
import type { OpenProjectTab } from "../../state/open-projects-store";
import { useRightDockStore } from "../../state/right-dock-store";

/**
 * A project's main checkout as a directory and file tree, shown in place of
 * the project's sessions when its header's file toggle is on. Selecting a
 * directory puts its standing agent in the right dock; opening a file does
 * the same for the file's directory. Rows reuse the right-dock file tree's
 * `TreeNode`. Sessions supply activity and sorting metadata but are not
 * rendered as rows here. Rows drag onto a composer as file references; the
 * tree itself is not a drop target, so nothing is moved from here.
 *
 * Showing the tree keeps the user's place: when the focused session lives in
 * this project, the tree opens down to the session's directory, that row is
 * marked and scrolled into view.
 */

// Same indentation as the right-dock file tree (file-tree.tsx).
const INDENT_BASE_PX = 18;
const INDENT_STEP_PX = 16;

const NO_SELECTION: FileNode[] = [];

export interface ProjectDirectoryTreeProps {
  project: OpenProjectTab;
  sortMode: DirectoryMapSortMode;
  /** The project's visible sessions, for activity indicators and sorting. */
  tasks: readonly StoredTask[];
  /** The session open in the centre pane when it belongs to this project. */
  focusedTask: StoredTask | null;
  t: TranslationFunction;
}

export const ProjectDirectoryTree = memo(function ProjectDirectoryTree({
  project,
  sortMode,
  tasks,
  focusedTask,
  t,
}: ProjectDirectoryTreeProps) {
  const { openProjectFile } = useProjectNavigation();
  const showDirectoryAgent = useRightDockStore((s) => s.showDirectoryAgent);
  const agentTarget = useRightDockStore((s) => s.agentTarget);
  const expanded = useDirectoryMapStore(
    (s) => (s.projects[project.id] ?? EMPTY_MAP_PROJECT).expanded,
  );
  const toggleDirectory = useDirectoryMapStore((s) => s.toggleDirectory);
  const revealDirectory = useDirectoryMapStore((s) => s.revealDirectory);
  const queryClient = useQueryClient();
  const treeRef = useRef<HTMLDivElement>(null);
  const { dragState, handlers: dndHandlers } = useFileTreeDnd({
    rootPath: null,
    selectedNodes: NO_SELECTION,
  });

  // The focused session's directory; null when it has none yet (the project
  // root) or lives elsewhere.
  const herePath = focusedTask?.home_dir || null;

  // Reveal once per focus change, and once per mount: this tree mounts every
  // time the files are shown, which is the user's request to see where they
  // are. Keyed on the session, not its directory, so an address assigned
  // later (first auto-commit) marks the row without moving the view.
  const revealKey = focusedTask?.id ?? null;
  const revealedKeyRef = useRef<string | null>(null);
  const scrolledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (revealKey === null || revealedKeyRef.current === revealKey) return;
    revealedKeyRef.current = revealKey;
    revealDirectory(project.id, herePath);
  }, [revealKey, herePath, project.id, revealDirectory]);

  // Scroll after the revealed row exists (the tree may still be loading), at
  // most once per reveal. `nearest` leaves a visible row alone.
  useEffect(() => {
    if (revealKey === null || scrolledKeyRef.current === revealKey) return;
    const target = treeRef.current?.querySelector('[data-focused="true"]');
    if (!target) return;
    scrolledKeyRef.current = revealKey;
    target.scrollIntoView({ block: "nearest" });
  });

  // The tree is fetched and watched only while it is shown: the fetch builds
  // the server's name index on first request, so a project left on its
  // sessions costs nothing.
  useEffect(
    () =>
      subscribeProjectTree(project.id, () => {
        void queryClient.invalidateQueries({
          queryKey: ["project-tree", project.id],
        });
        void queryClient.invalidateQueries({
          queryKey: ["directory-agent", project.id],
        });
      }),
    [project.id, queryClient],
  );

  const { data: tree } = useQuery({
    queryKey: ["project-tree", project.id],
    queryFn: () => fetchProjectTree(project.id),
    staleTime: 30_000,
  });
  // Sessions filed by address. A session without one has no place in the
  // tree yet; it still shows in the session list.
  const homedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const task of tasks) {
      if (task.home_dir != null && task.home_dir !== "")
        dirs.add(task.home_dir);
    }
    return [...dirs];
  }, [tasks]);

  // The tree is main's checkout, but a session may be addressed to a directory
  // its worktree created and main does not have yet. Such addresses are added
  // as directories so every homed session has a place in the tree.
  const lastActivity = useMemo(() => directoryLastActivity(tasks), [tasks]);
  const root = useMemo(
    () =>
      buildDirectoryTree(
        [
          ...(tree?.entries ?? []),
          ...homedDirs.map((dir) => ({ path: dir, isFile: false })),
        ],
        sortMode,
        lastActivity,
      ),
    [tree?.entries, homedDirs, sortMode, lastActivity],
  );

  // Directories whose subtree has a running session; each maps to whether the
  // agent is blocked on input (then the row shows the pause glyph instead).
  const activityByDir = useMemo(() => {
    const activity = new Map<string, boolean>();
    for (const task of tasks) {
      if (task.home_dir == null || !task.active_session_id) continue;
      for (const dir of ancestorDirectories(task.home_dir)) {
        activity.set(
          dir,
          (activity.get(dir) ?? false) || Boolean(task.awaiting_input),
        );
      }
    }
    return activity;
  }, [tasks]);

  const targetPath =
    agentTarget?.projectId === project.id ? agentTarget.path : null;

  const selectDirectory = useCallback(
    (path: string) => showDirectoryAgent({ projectId: project.id, path }),
    [showDirectoryAgent, project.id],
  );

  const openFile = useCallback(
    (path: string) => {
      openProjectFile(project, path);
      selectDirectory(parentDirectory(path));
    },
    [openProjectFile, project, selectDirectory],
  );

  const renderNode = (node: DirectoryTreeNode, depth: number) => {
    // A directory row may stand for a whole single-folder run; it then acts
    // on the run's deepest directory. Activity is read at the run's head,
    // which already rolls up everything below it.
    const chain = node.isFile
      ? { tail: node, label: node.name, paths: [node.path] }
      : compactDirectoryChain(node);
    const { tail } = chain;
    const isExpanded = !tail.isFile && expanded.has(tail.path);
    const running = activityByDir.get(node.path);
    const isHere =
      !node.isFile && herePath !== null && chain.paths.includes(herePath);
    const fileNode: FileNode = {
      id: `map:${project.id}:${tail.path}`,
      name: chain.label,
      displayName: getDisplayName(
        chain.label,
        tail.isFile ? FileNodeType.File : FileNodeType.Directory,
      ),
      path: `/${tail.path}`,
      type: tail.isFile ? FileNodeType.File : FileNodeType.Directory,
      relativePath: tail.path,
      hasChildren: tail.children.length > 0,
    };
    return (
      <div key={node.path}>
        <TreeNode
          node={fileNode}
          isExpanded={isExpanded}
          isSelected={!tail.isFile && targetPath === tail.path}
          isFocused={isHere}
          indentPx={INDENT_BASE_PX + depth * INDENT_STEP_PX}
          onToggle={() => toggleDirectory(project.id, tail.path)}
          onSelect={() =>
            selectDirectory(
              tail.isFile ? parentDirectory(tail.path) : tail.path,
            )
          }
          onOpen={tail.isFile ? () => openFile(tail.path) : undefined}
          onMouseDown={(e) => dndHandlers.onMouseDown(e, fileNode)}
          isDragging={
            dragState.isDragging &&
            dragState.draggedNodes.some(
              (dragged) => dragged.path === fileNode.path,
            )
          }
          trailing={
            running !== undefined ? (
              <SessionActivityIndicator awaitingInput={running} t={t} />
            ) : null
          }
        />
        {isExpanded
          ? tail.children.map((child) => renderNode(child, depth + 1))
          : null}
      </div>
    );
  };

  return (
    <div ref={treeRef} className="tree-group-reveal mt-0.5">
      {tree === undefined ? (
        <div className="py-1.5 pl-5 text-xs text-custom-sidebar-text-400">
          {t("loadingMessage")}
        </div>
      ) : (
        <>
          {tree.overflowed ? (
            <div className="py-1.5 pl-5 text-xs text-custom-sidebar-text-400">
              {t("mapTooManyFiles")}
            </div>
          ) : null}
          {root.children.map((child) => renderNode(child, 0))}
        </>
      )}
    </div>
  );
});
