import { useProjectContext } from "@/files/context/project-context";
import { type TranslationFunction, useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { revealInFinder } from "@/lib/project-client";
import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { ArchivePopover } from "@/session/components/archive-popover";
import { TaskStatusDot } from "@/session/components/task-status-dot";
import { applyPendingSubmissionsToTasks } from "@/session/domain/session-task-state";
import {
  useArchivedSessions,
  useMarkViewedWhenActive,
  useProjectTasksStream,
  useTaskStatusDot,
} from "@/session/hooks";
import { usePendingSessionSubmissions } from "@/session/state/pending-session-submissions-store";
import type { StoredTask } from "@/session/types";
import {
  SESSION_DRAG_DATA_TYPE,
  serializeSessionDragPayload,
} from "@/session/utils/session-dnd";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@chro/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { LoadingDot } from "@chro/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ProjectNavigation,
  useProjectNavigation,
} from "../../hooks/use-project-navigation";
import { useProjectsRecentActivity } from "../../hooks/use-projects-recent-activity";
import { useLayoutStore } from "../../state/layout-store";
import {
  type OpenProjectTab,
  useOpenProjectsStore,
} from "../../state/open-projects-store";
import { useProjectTreeStore } from "../../state/project-tree-store";
import { ProjectSwitcherDropdown } from "../project-switcher-dropdown";

const ICON_BUTTON_CLASS =
  "inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-1.5 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40";

/**
 * Projects-panel sort modes, picked from the header overflow menu.
 * `name-asc`/`name-desc` order projects alphabetically, and `recent` orders
 * them (and their chats) by the most recent task completion.
 */
type SortMode = "name-asc" | "name-desc" | "recent";

const DEFAULT_SORT_MODE: SortMode = "name-asc";
const SORT_MODE_STORAGE_KEY = "workspace-layout:projects-sort-mode:v1";

const SORT_OPTIONS: readonly {
  mode: SortMode;
  labelKey: "sortProjectsAsc" | "sortProjectsDesc" | "sortProjectsRecent";
}[] = [
  { mode: "name-asc", labelKey: "sortProjectsAsc" },
  { mode: "name-desc", labelKey: "sortProjectsDesc" },
  { mode: "recent", labelKey: "sortProjectsRecent" },
];

const isSortMode = (value: unknown): value is SortMode =>
  value === "name-asc" || value === "name-desc" || value === "recent";

const readPersistedSortMode = (): SortMode | null => {
  const value = getUiValue<unknown>(SORT_MODE_STORAGE_KEY);
  return isSortMode(value) ? value : null;
};

function useStableCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}

const formatRelativeTime = (input: Date | string): string => {
  const date = input instanceof Date ? input : new Date(input);
  const diffMins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
};

/**
 * Left-dock panel: the open projects rendered as a tree, each expandable to
 * reveal its chats. Replaces the per-project session sidebar and the header
 * project tabs — switching projects now happens by clicking a project (or one
 * of its chats) in this tree.
 */
export function ProjectsDockPanel() {
  const { t } = useLanguage();
  const projects = useOpenProjectsStore((s) => s.projects);
  const hydrateProjectTree = useProjectTreeStore((s) => s.hydrate);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const userSelectedSortModeRef = useRef(false);
  const [sortMode, setSortModeState] = useState<SortMode>(
    () => readPersistedSortMode() ?? DEFAULT_SORT_MODE,
  );

  const setSortMode = useCallback((nextMode: SortMode) => {
    userSelectedSortModeRef.current = true;
    setSortModeState(nextMode);
    setUiValue(SORT_MODE_STORAGE_KEY, nextMode);
  }, []);

  useEffect(() => {
    const hydrateSortMode = () => {
      if (!isUiStateReady()) return false;
      if (!userSelectedSortModeRef.current) {
        setSortModeState(readPersistedSortMode() ?? DEFAULT_SORT_MODE);
      }
      return true;
    };

    if (hydrateSortMode()) return;
    const id = window.setInterval(() => {
      if (hydrateSortMode()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (hydrateProjectTree()) return;
    const id = window.setInterval(() => {
      if (hydrateProjectTree()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [hydrateProjectTree]);

  const recentActivity = useProjectsRecentActivity(
    projects,
    sortMode === "recent",
  );

  const sortedProjects = [...projects].sort((a, b) => {
    if (sortMode === "recent") {
      const diff = (recentActivity[b.id] ?? 0) - (recentActivity[a.id] ?? 0);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    }
    const cmp = a.name.localeCompare(b.name);
    return sortMode === "name-asc" ? cmp : -cmp;
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("sortProjects")}
              className={ICON_BUTTON_CLASS}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel>{t("sortProjects")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(value) => {
                if (isSortMode(value)) setSortMode(value);
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.mode} value={option.mode}>
                  {t(option.labelKey)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center gap-0.5">
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <ProjectSwitcherDropdown
                    open={switcherOpen}
                    onOpenChange={setSwitcherOpen}
                    align="end"
                    side="bottom"
                    trigger={
                      <button
                        type="button"
                        aria-label={t("openAnotherProject")}
                        onClick={() => setSwitcherOpen(true)}
                        className={ICON_BUTTON_CLASS}
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    }
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {t("openAnotherProject")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
      <ProjectRows
        projects={sortedProjects}
        sortByRecent={sortMode === "recent"}
        t={t}
      />
    </div>
  );
}

interface ProjectRowsProps {
  projects: OpenProjectTab[];
  sortByRecent: boolean;
  t: TranslationFunction;
}

const ProjectRows = memo(function ProjectRows({
  projects,
  sortByRecent,
  t,
}: ProjectRowsProps) {
  const { projectId: currentProjectId } = useProjectContext();
  const projectTreeHydrated = useProjectTreeStore((s) => s.hydrated);
  const ensureExpanded = useProjectTreeStore((s) => s.ensureExpanded);
  const activeTaskKey = useFocusedSessionTaskKey();
  const { activateProject, openSession, newSession } = useProjectNavigation();
  const navigate = useNavigate();

  const navigateHome = useCallback(() => {
    navigate({ to: "/" });
  }, [navigate]);
  const stableActivateProject = useStableCallback(activateProject);
  const stableOpenSession = useStableCallback(openSession);
  const stableNewSession = useStableCallback(newSession);
  const stableNavigateHome = useStableCallback(navigateHome);

  // Default new/unseen projects to expanded, while preserving projects the
  // user explicitly collapsed in persisted state.
  useEffect(() => {
    if (projectTreeHydrated && currentProjectId) {
      ensureExpanded(currentProjectId);
    }
  }, [currentProjectId, ensureExpanded, projectTreeHydrated]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {projects.map((project) => (
        <ProjectTreeNode
          key={project.id}
          project={project}
          isCurrent={project.id === currentProjectId}
          activeTaskKey={project.id === currentProjectId ? activeTaskKey : null}
          sortByRecent={sortByRecent}
          activateProject={stableActivateProject}
          openSession={stableOpenSession}
          newSession={stableNewSession}
          navigateHome={stableNavigateHome}
          t={t}
        />
      ))}
    </div>
  );
});

interface ProjectTreeNodeProps {
  project: OpenProjectTab;
  isCurrent: boolean;
  activeTaskKey: string | null;
  sortByRecent: boolean;
  activateProject: ProjectNavigation["activateProject"];
  openSession: ProjectNavigation["openSession"];
  newSession: ProjectNavigation["newSession"];
  navigateHome: () => void;
  t: TranslationFunction;
}

const ProjectTreeNode = memo(function ProjectTreeNode({
  project,
  isCurrent,
  activeTaskKey,
  sortByRecent,
  activateProject,
  openSession,
  newSession,
  navigateHome,
  t,
}: ProjectTreeNodeProps) {
  const expanded = useProjectTreeStore((s) => s.expanded.has(project.id));
  const toggle = useProjectTreeStore((s) => s.toggle);
  const expand = useProjectTreeStore((s) => s.expand);
  const { archiveSession, restoreSession, isArchived } = useArchivedSessions();
  const closeProject = useOpenProjectsStore((s) => s.closeProject);

  // Left dock is cross-project chrome, so keep task data keyed by each row's
  // project instead of switching the current row to ProjectTasksProvider data.
  const {
    tasks: streamedTasks,
    tasksById: streamedTasksById,
    isLoading,
  } = useProjectTasksStream({
    projectId: project.id,
    enabled: expanded,
  });
  const pendingSubmissions = usePendingSessionSubmissions(
    project.id,
    streamedTasksById,
  );
  const fallbackTasks = useMemo(
    () =>
      applyPendingSubmissionsToTasks(
        streamedTasks,
        pendingSubmissions,
        project.id,
      ),
    [pendingSubmissions, project.id, streamedTasks],
  );
  const tasks = fallbackTasks;
  const tasksLoading = isLoading;

  useEffect(() => {
    if (pendingSubmissions.length > 0) {
      expand(project.id);
    }
  }, [expand, pendingSubmissions.length, project.id]);

  const activeChats = tasks.filter((task) => !isArchived(task));
  // In recency mode surface the most recently completed chat first, overriding
  // the default task ordering.
  const chats = sortByRecent
    ? [...activeChats].sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )
    : activeChats;
  const archivedSessions = tasks
    .filter((task) => isArchived(task))
    .map((task) => ({
      id: task.id,
      title: task.title,
      archivedAt: task.updated_at,
    }));

  const handleRowClick = () => {
    if (isCurrent) {
      toggle(project.id);
    } else {
      activateProject(project);
      expand(project.id);
    }
  };

  // Keep clicks on row-level action buttons from also triggering the row's
  // switch/toggle handler.
  const stop = (event: ReactMouseEvent) => event.stopPropagation();

  const handleRevealInFinder = () => {
    revealInFinder(project.id, "/").catch((error) => {
      console.warn("[projects-panel] Failed to reveal in finder:", error);
    });
  };

  // "Remove" only drops the project from the sidebar's open-projects list — it
  // never deletes anything on disk. When the active project is removed, hand
  // focus to the next open project, or the home route when none remain.
  const handleRemove = () => {
    const remaining = closeProject(project.id);
    if (!isCurrent) return;
    const next = remaining[0];
    if (next) {
      activateProject(next);
    } else {
      navigateHome();
    }
  };

  return (
    <div className="mb-0.5">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-expanded={expanded}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: role="treeitem" requires keyboard focus for Enter/Space activation
            tabIndex={0}
            onClick={handleRowClick}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleRowClick();
              }
            }}
            title={project.workspacePath ?? project.name}
            className={cn(
              "group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-[3px] px-1.5",
              "text-custom-sidebar-text-200 hover:bg-custom-sidebar-background-80",
            )}
          >
            <button
              type="button"
              aria-label={expanded ? "Collapse" : "Expand"}
              onClick={(event) => {
                stop(event);
                toggle(project.id);
              }}
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-custom-sidebar-text-400"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  expanded && "rotate-90",
                )}
              />
            </button>
            {expanded ? (
              <FolderOpen className="h-4 w-4 shrink-0 text-custom-sidebar-text-300" />
            ) : (
              <Folder className="h-4 w-4 shrink-0 text-custom-sidebar-text-300" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                isCurrent
                  ? "font-medium text-custom-sidebar-text-100"
                  : "text-custom-sidebar-text-200",
              )}
            >
              {project.name}
            </span>
            <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
              {archivedSessions.length > 0 ? (
                <ArchivePopover
                  trigger={
                    <button
                      type="button"
                      aria-label="Archive"
                      onClick={stop}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100"
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </button>
                  }
                  archivedSessions={archivedSessions}
                  onRestore={restoreSession}
                />
              ) : null}
              <button
                type="button"
                aria-label={t("newChat")}
                onClick={(event) => {
                  stop(event);
                  newSession(project);
                }}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="z-20 w-52 rounded border border-custom-border-200 bg-custom-background-100 p-1 shadow-lg">
          <ContextMenuItem
            onSelect={handleRevealInFinder}
            disabled={!project.workspacePath}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span>{t("revealInFinder")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
          <ContextMenuItem
            onSelect={handleRemove}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <X className="h-3.5 w-3.5 shrink-0" />
            <span>{t("removeProjectFromSidebar")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {expanded ? (
        <div className="mt-0.5 flex flex-col">
          {tasksLoading && chats.length === 0 ? (
            <div className="flex items-center gap-2 py-1.5 pl-9 text-xs text-custom-sidebar-text-400">
              <LoadingDot isLoading className="h-3 w-3" />
            </div>
          ) : chats.length === 0 ? (
            <div className="py-1.5 pl-9 text-sm text-custom-sidebar-text-400">
              {t("noChats")}
            </div>
          ) : (
            chats.map((task) => (
              <ChatRow
                key={task.id}
                task={task}
                isActive={
                  activeTaskKey === task.id || activeTaskKey === task.slug
                }
                onOpen={() => openSession(project, task)}
                onArchive={() => archiveSession(task)}
                t={t}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
});

interface ChatRowProps {
  task: StoredTask;
  isActive: boolean;
  onOpen: () => void;
  onArchive: () => void;
  t: TranslationFunction;
}

function ChatRow({ task, isActive, onOpen, onArchive, t }: ChatRowProps) {
  const isRunning = Boolean(task.active_session_id);
  const dotKind = useTaskStatusDot(task);
  useMarkViewedWhenActive(task, isActive);
  return (
    <div
      role="option"
      aria-selected={isActive}
      tabIndex={0}
      draggable
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          SESSION_DRAG_DATA_TYPE,
          serializeSessionDragPayload({
            taskId: task.id,
            branch: task.branch ?? null,
          }),
        );
        event.dataTransfer.setData(
          "text/plain",
          task.title?.trim() || task.id.slice(0, 8),
        );
      }}
      className={cn(
        "group/chat flex cursor-pointer items-center justify-between gap-2 rounded-[3px] py-1.5 pl-9 pr-2.5",
        isActive
          ? "bg-custom-sidebar-background-80"
          : "hover:bg-custom-sidebar-background-80",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="flex w-2 shrink-0 items-center justify-center">
          <TaskStatusDot
            kind={dotKind}
            label={
              dotKind === "failed"
                ? t("sessionFailedUnread")
                : t("sessionCompletedUnread")
            }
          />
        </span>
        {task.title ? (
          <span className="min-w-0 flex-1 truncate text-sm text-custom-sidebar-text-100">
            {task.title}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-custom-sidebar-text-400">
            {t("sessionUnresolved")}
          </span>
        )}
      </div>
      <span className="flex shrink-0 items-center">
        {isRunning ? (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-custom-primary-100"
            aria-label={t("waitingMessage")}
          />
        ) : (
          <>
            <span className="text-sm text-custom-sidebar-text-400 group-hover/chat:hidden">
              {formatRelativeTime(task.updated_at)}
            </span>
            <button
              type="button"
              aria-label="Archive session"
              onClick={(event) => {
                event.stopPropagation();
                onArchive();
              }}
              className="hidden items-center justify-center rounded p-0.5 text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100 group-hover/chat:flex"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Raw focused-session task identifier (slug or id) for the bound layout, or
 * null when the focused tab isn't a session. The layout is bound to the
 * current project, so this only ever matches a chat under the current
 * project's node.
 */
function useFocusedSessionTaskKey(): string | null {
  const layout = useLayoutStore((s) => s.layout);
  const focused = layout.focusedPaneId;
  const stack = [layout.root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "leaf") {
      if (node.id !== focused) continue;
      const tab = node.tabs.find((entry) => entry.id === node.activeTabId);
      if (tab && tab.kind.type === "session") {
        return tab.kind.taskId ?? null;
      }
      return null;
    }
    stack.push(node.children[0], node.children[1]);
  }
  return null;
}
