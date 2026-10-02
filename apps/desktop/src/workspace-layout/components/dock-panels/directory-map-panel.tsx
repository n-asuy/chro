import { TreeNode } from "@/files/components/file-tree/tree-node";
import {
  type FileNode,
  FileNodeType,
  getDisplayName,
} from "@/files/types/file-tree";
import type { TranslationFunction } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  fetchProjectTree,
  subscribeProjectTree,
} from "@/lib/directory-map-client";
import { SessionActivityIndicator } from "@/session/components/session-activity-indicator";
import { projectBadgeColor } from "@/session/domain/project-color";
import type { StoredTask } from "@/session/types";
import type { ProjectResponse } from "@/tasks/task-api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useMemo } from "react";
import {
  type DirectoryMapSortMode,
  type DirectoryTreeNode,
  ancestorDirectories,
  buildDirectoryTree,
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
import { ProjectColorDot } from "../project-color-dot";

/**
 * The Map axis of the left panel: every open project's main checkout as a
 * directory and file tree. Selecting a directory puts its standing agent in
 * the right dock; opening a file does the same for the file's directory.
 * Rows reuse the right-dock file tree's `TreeNode`. Sessions supply activity
 * and sorting metadata but are not rendered as rows in the Map.
 */

// Same indentation as the right-dock file tree (file-tree.tsx).
const INDENT_BASE_PX = 18;
const INDENT_STEP_PX = 16;

export interface DirectoryMapListProps {
  projects: OpenProjectTab[];
  projectsById: Record<string, ProjectResponse>;
  sortMode: DirectoryMapSortMode;
  /** Visible sessions used for activity indicators and recent sorting. */
  tasks: StoredTask[];
  t: TranslationFunction;
}

export function DirectoryMapList({
  projects,
  projectsById,
  sortMode,
  tasks,
  t,
}: DirectoryMapListProps) {
  const tasksByProject = useMemo(() => {
    const byProject: Record<string, StoredTask[]> = {};
    for (const task of tasks) {
      const list = byProject[task.project_id] ?? [];
      byProject[task.project_id] = list;
      list.push(task);
    }
    return byProject;
  }, [tasks]);

  const sortedProjects = useMemo(() => {
    const latest = new Map<string, number>();
    for (const task of tasks) {
      if (task.home_dir == null) continue;
      const at = Date.parse(task.updated_at);
      if (Number.isFinite(at)) {
        latest.set(
          task.project_id,
          Math.max(latest.get(task.project_id) ?? 0, at),
        );
      }
    }
    return [...projects].sort((a, b) => {
      if (sortMode === "recent") {
        const diff = (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0);
        if (diff !== 0) return diff;
      }
      const cmp = a.name.localeCompare(b.name);
      return sortMode === "name-desc" ? -cmp : cmp;
    });
  }, [projects, tasks, sortMode]);

  if (projects.length === 0) {
    return (
      <div className="py-1.5 pl-2.5 text-sm text-custom-sidebar-text-400">
        {t("noProjectsYet")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {sortedProjects.map((project) => (
        <MapProject
          key={project.id}
          project={project}
          projectRecord={projectsById[project.id] ?? null}
          sortMode={sortMode}
          tasks={tasksByProject[project.id] ?? []}
          t={t}
        />
      ))}
    </div>
  );
}

interface MapProjectProps {
  project: OpenProjectTab;
  projectRecord: ProjectResponse | null;
  sortMode: DirectoryMapSortMode;
  tasks: StoredTask[];
  t: TranslationFunction;
}

const MapProject = memo(function MapProject({
  project,
  projectRecord,
  sortMode,
  tasks,
  t,
}: MapProjectProps) {
  const { activateProject, openProjectFile } = useProjectNavigation();
  const showDirectoryAgent = useRightDockStore((s) => s.showDirectoryAgent);
  const agentTarget = useRightDockStore((s) => s.agentTarget);
  const { collapsed, expanded } = useDirectoryMapStore(
    (s) => s.projects[project.id] ?? EMPTY_MAP_PROJECT,
  );
  const toggleProject = useDirectoryMapStore((s) => s.toggleProject);
  const toggleDirectory = useDirectoryMapStore((s) => s.toggleDirectory);
  const revealHomedDirectories = useDirectoryMapStore(
    (s) => s.revealHomedDirectories,
  );
  const queryClient = useQueryClient();

  // A folded project costs nothing: no tree fetch (which builds the server's
  // name index on first request) and no change subscription. Both start when
  // the user opens the project and stop when it is folded again.
  useEffect(() => {
    if (collapsed) return;
    return subscribeProjectTree(project.id, () => {
      void queryClient.invalidateQueries({
        queryKey: ["project-tree", project.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["directory-agent", project.id],
      });
    });
  }, [collapsed, project.id, queryClient]);

  const { data: tree } = useQuery({
    queryKey: ["project-tree", project.id],
    queryFn: () => fetchProjectTree(project.id),
    staleTime: 30_000,
    enabled: !collapsed,
  });
  // Sessions filed by address. A session without one is not on the map yet;
  // it still shows in the Inbox.
  const tasksByDir = useMemo(() => {
    const byDir: Record<string, StoredTask[]> = {};
    for (const task of tasks) {
      if (task.home_dir == null) continue;
      const list = byDir[task.home_dir] ?? [];
      byDir[task.home_dir] = list;
      list.push(task);
    }
    return byDir;
  }, [tasks]);

  // The tree is main's checkout, but a session may be addressed to a directory
  // its worktree created and main does not have yet. Such addresses are added
  // as directories so every homed session has a place on the map.
  const lastActivity = useMemo(() => directoryLastActivity(tasks), [tasks]);
  const root = useMemo(
    () =>
      buildDirectoryTree(
        [
          ...(tree?.entries ?? []),
          ...Object.keys(tasksByDir)
            .filter((dir) => dir !== "")
            .map((dir) => ({ path: dir, isFile: false })),
        ],
        sortMode,
        lastActivity,
      ),
    [tree?.entries, tasksByDir, sortMode, lastActivity],
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

  // Reveal each newly seen address once. The store remembers addresses across
  // Inbox/Map switches, so remounts and task-stream patches preserve folding.
  useEffect(() => {
    revealHomedDirectories(project.id, Object.keys(tasksByDir));
  }, [project.id, tasksByDir, revealHomedDirectories]);

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

  const headerColor = projectBadgeColor(projectRecord?.badgeColor);

  const renderNode = (node: DirectoryTreeNode, depth: number) => {
    const isExpanded = !node.isFile && expanded.has(node.path);
    const running = activityByDir.get(node.path);
    const fileNode: FileNode = {
      id: `map:${project.id}:${node.path}`,
      name: node.name,
      displayName: getDisplayName(
        node.name,
        node.isFile ? FileNodeType.File : FileNodeType.Directory,
      ),
      path: `/${node.path}`,
      type: node.isFile ? FileNodeType.File : FileNodeType.Directory,
      relativePath: node.path,
      hasChildren: node.children.length > 0,
    };
    return (
      <div key={node.path}>
        <TreeNode
          node={fileNode}
          isExpanded={isExpanded}
          isSelected={!node.isFile && targetPath === node.path}
          isFocused={false}
          indentPx={INDENT_BASE_PX + depth * INDENT_STEP_PX}
          onToggle={() => toggleDirectory(project.id, node.path)}
          onSelect={() =>
            selectDirectory(
              node.isFile ? parentDirectory(node.path) : node.path,
            )
          }
          onOpen={node.isFile ? () => openFile(node.path) : undefined}
          trailing={
            running !== undefined ? (
              <SessionActivityIndicator awaitingInput={running} t={t} />
            ) : null
          }
        />
        {isExpanded
          ? node.children.map((child) => renderNode(child, depth + 1))
          : null}
      </div>
    );
  };

  return (
    <div>
      <div
        role="treeitem"
        aria-expanded={!collapsed}
        data-project-id={project.id}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: role="treeitem" requires keyboard focus for Enter/Space activation
        tabIndex={0}
        onClick={() => activateProject(project)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activateProject(project);
          }
        }}
        title={project.workspacePath ?? project.name}
        className={cn(
          "group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 transition-colors",
          "text-custom-sidebar-text-200 hover:bg-foreground/5",
        )}
      >
        <button
          type="button"
          aria-label={collapsed ? "Expand" : "Collapse"}
          onClick={(event) => {
            event.stopPropagation();
            toggleProject(project.id);
          }}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-custom-sidebar-text-400"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        {headerColor ? <ProjectColorDot color={headerColor} /> : null}
        <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
      </div>
      {collapsed ? null : (
        <div className="tree-group-reveal mt-0.5">
          {tree === undefined ? (
            <div className="py-1.5 pl-2.5 text-xs text-custom-sidebar-text-400">
              {t("loadingMessage")}
            </div>
          ) : (
            <>
              {tree.overflowed ? (
                <div className="py-1.5 pl-2.5 text-xs text-custom-sidebar-text-400">
                  {t("mapTooManyFiles")}
                </div>
              ) : null}
              {root.children.map((child) => renderNode(child, 0))}
            </>
          )}
        </div>
      )}
    </div>
  );
});
