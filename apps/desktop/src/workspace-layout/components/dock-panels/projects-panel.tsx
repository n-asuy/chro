import { FolderOpenSolidIcon, FolderSolidIcon } from "@/components/folder-icon";
import { useProjectContext } from "@/files/context/project-context";
import { type TranslationFunction, useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { revealInFinder } from "@/lib/project-client";
import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { ArchivePopover } from "@/session/components/archive-popover";
import { SessionActivityIndicator } from "@/session/components/session-activity-indicator";
import {
  SessionPreviewProvider,
  useSessionPreviewTrigger,
} from "@/session/components/session-preview";
import { TaskStatusDot } from "@/session/components/task-status-dot";
import { applyPendingSubmissionsToTasks } from "@/session/domain/session-task-state";
import {
  useArchivedSessions,
  useInboxTasksStream,
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
  DropdownMenuItem,
  DropdownMenuLabel,
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
  ArrowDownUp,
  Check,
  ChevronRight,
  ExternalLink,
  Folders,
  Inbox,
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
import { useAllProjects } from "../../hooks/use-all-projects";
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
import { SegmentedControl, type SegmentedItem } from "../segmented-control";
import { ViewFade } from "../view-fade";

const ICON_BUTTON_CLASS =
  "inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40";

/**
 * Tree-guide geometry for a project's expanded chats. The vertical trunk drops
 * from under the project row's chevron; each chat gets a horizontal tick, and
 * the final chat's trunk stops at its tick to form the `└` corner.
 */
const TREE_GUIDE_LEFT_PX = 15;
const TREE_GUIDE_TICK_PX = 8;

/**
 * Connector lines drawn behind a chat row: a vertical trunk under the project
 * chevron plus a horizontal tick into the row. The last chat's trunk stops at
 * the tick, drawing the `└` corner that closes the branch.
 */
function TreeGuide({ isLast }: { isLast: boolean }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0">
      <span
        className="absolute top-0 w-px bg-custom-border-300"
        style={{
          left: `${TREE_GUIDE_LEFT_PX}px`,
          height: isLast ? "50%" : "100%",
        }}
      />
      <span
        className="absolute top-1/2 h-px bg-custom-border-300"
        style={{
          left: `${TREE_GUIDE_LEFT_PX}px`,
          width: `${TREE_GUIDE_TICK_PX}px`,
        }}
      />
    </span>
  );
}

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
/**
 * Left-dock view mode. `projects` is the per-project tree; `inbox` is a flat,
 * cross-project list of every session ordered by recency.
 */
type PanelView = "projects" | "inbox";

export function ProjectsDockPanel() {
  const { t } = useLanguage();
  const [view, setView] = useState<PanelView>("projects");
  const viewSegments: SegmentedItem<PanelView>[] = [
    { value: "projects", icon: Folders, label: t("projects") },
    { value: "inbox", icon: Inbox, label: t("inbox") },
  ];
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
    <SessionPreviewProvider>
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-1">
            <SegmentedControl
              items={viewSegments}
              value={view}
              onValueChange={setView}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("sortProjects")}
                  className={ICON_BUTTON_CLASS}
                >
                  <ArrowDownUp className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom" className="w-48">
                <DropdownMenuLabel className="-mx-1 -mt-1 mb-1 border-border/40 border-b px-3 py-1.5 font-normal text-[11px] text-muted-foreground">
                  {t("sortProjects")}
                </DropdownMenuLabel>
                {SORT_OPTIONS.map((option) => {
                  const isActive = option.mode === sortMode;
                  return (
                    <DropdownMenuItem
                      key={option.mode}
                      onSelect={() => setSortMode(option.mode)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-1 text-[13px]",
                        isActive && "bg-muted text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {t(option.labelKey)}
                      </span>
                      {isActive ? (
                        <Check className="h-3.5 w-3.5 shrink-0" />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <ProjectSwitcherDropdown
                      open={switcherOpen}
                      onOpenChange={setSwitcherOpen}
                      align="start"
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
        <ViewFade viewKey={view} className="flex min-h-0 flex-1 flex-col">
          {view === "inbox" ? (
            <InboxRows t={t} />
          ) : (
            <ProjectRows
              projects={sortedProjects}
              sortByRecent={sortMode === "recent"}
              t={t}
            />
          )}
        </ViewFade>
      </div>
    </SessionPreviewProvider>
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

interface InboxRowsProps {
  t: TranslationFunction;
}

/**
 * Flat, cross-project session list ordered by most-recent activity. Streams
 * every project's tasks at once (no per-project grouping) and resolves each
 * task's owning project name for a subtle secondary label. Archived sessions
 * are hidden, matching the project tree's main list.
 */
const InboxRows = memo(function InboxRows({ t }: InboxRowsProps) {
  const { tasks, isLoading } = useInboxTasksStream(true);
  const projectsById = useAllProjects(true);
  const { archiveSession, isArchived } = useArchivedSessions();
  const activeTaskKey = useFocusedSessionTaskKey();
  const navigate = useNavigate();

  const visibleTasks = useMemo(
    () => tasks.filter((task) => !isArchived(task)),
    [tasks, isArchived],
  );

  const openInboxSession = useCallback(
    (task: StoredTask) => {
      const projectId = projectsById[task.project_id]?.slug ?? task.project_id;
      navigate({
        to: "/projects/$projectId/session/$taskId",
        params: { projectId, taskId: task.slug ?? task.id },
      });
    },
    [navigate, projectsById],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {isLoading && visibleTasks.length === 0 ? (
        <div className="flex items-center gap-2 py-1.5 pl-2.5 text-xs text-custom-sidebar-text-400">
          <LoadingDot isLoading className="h-3 w-3" />
        </div>
      ) : visibleTasks.length === 0 ? (
        <div className="py-1.5 pl-2.5 text-sm text-custom-sidebar-text-400">
          {t("inboxEmpty")}
        </div>
      ) : (
        visibleTasks.map((task) => (
          <InboxRow
            key={task.id}
            task={task}
            projectName={projectsById[task.project_id]?.name ?? null}
            isActive={activeTaskKey === task.id || activeTaskKey === task.slug}
            onOpen={() => openInboxSession(task)}
            onArchive={() => archiveSession(task)}
            t={t}
          />
        ))
      )}
    </div>
  );
});

interface InboxRowProps {
  task: StoredTask;
  projectName: string | null;
  isActive: boolean;
  onOpen: () => void;
  onArchive: () => void;
  t: TranslationFunction;
}

function InboxRow({
  task,
  projectName,
  isActive,
  onOpen,
  onArchive,
  t,
}: InboxRowProps) {
  const isRunning = Boolean(task.active_session_id);
  const isAwaitingInput = Boolean(task.awaiting_input);
  const dotKind = useTaskStatusDot(task);
  useMarkViewedWhenActive(task, isActive);
  const preview = useSessionPreviewTrigger(task);
  return (
    <div
      ref={preview.setAnchor}
      role="option"
      aria-selected={isActive}
      tabIndex={0}
      onClick={onOpen}
      onPointerEnter={preview.hoverProps.onPointerEnter}
      onPointerLeave={preview.hoverProps.onPointerLeave}
      onPointerDown={preview.hoverProps.onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group/inbox flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5",
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
        <span className="flex min-w-0 flex-1 flex-col">
          {task.title ? (
            <span className="truncate text-sm text-custom-sidebar-text-100">
              {task.title}
            </span>
          ) : (
            <span className="truncate text-sm text-custom-sidebar-text-400">
              {t("sessionUnresolved")}
            </span>
          )}
          {projectName ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {projectName}
            </span>
          ) : null}
        </span>
      </div>
      <span className="flex shrink-0 items-center">
        {isRunning ? (
          <SessionActivityIndicator awaitingInput={isAwaitingInput} t={t} />
        ) : (
          <>
            <span className="text-sm text-custom-sidebar-text-400 group-hover/inbox:hidden">
              {formatRelativeTime(task.updated_at)}
            </span>
            <button
              type="button"
              aria-label="Archive session"
              onClick={(event) => {
                event.stopPropagation();
                onArchive();
              }}
              className="hidden items-center justify-center rounded p-0.5 text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100 group-hover/inbox:flex"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </span>
    </div>
  );
}

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

  // Clicking the project name always lands on the project Home (overview),
  // for the current project as well as a different one. Expand/collapse of the
  // chat tree is reserved for the chevron button so a single click has one
  // predictable outcome.
  const handleRowClick = () => {
    activateProject(project);
    expand(project.id);
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
              "group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5",
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
              <FolderOpenSolidIcon className="h-4 w-4 shrink-0 text-custom-sidebar-text-300" />
            ) : (
              <FolderSolidIcon className="h-4 w-4 shrink-0 text-custom-sidebar-text-300" />
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
        <ContextMenuContent className="z-20 w-52 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
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
            chats.map((task, index) => (
              <ChatRow
                key={task.id}
                task={task}
                isActive={
                  activeTaskKey === task.id || activeTaskKey === task.slug
                }
                isLast={index === chats.length - 1}
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
  isLast: boolean;
  onOpen: () => void;
  onArchive: () => void;
  t: TranslationFunction;
}

function ChatRow({
  task,
  isActive,
  isLast,
  onOpen,
  onArchive,
  t,
}: ChatRowProps) {
  const isRunning = Boolean(task.active_session_id);
  const isAwaitingInput = Boolean(task.awaiting_input);
  const dotKind = useTaskStatusDot(task);
  useMarkViewedWhenActive(task, isActive);
  const preview = useSessionPreviewTrigger(task);
  return (
    <div
      ref={preview.setAnchor}
      role="option"
      aria-selected={isActive}
      tabIndex={0}
      draggable
      onClick={onOpen}
      onPointerEnter={preview.hoverProps.onPointerEnter}
      onPointerLeave={preview.hoverProps.onPointerLeave}
      onPointerDown={preview.hoverProps.onPointerDown}
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
        "group/chat relative flex cursor-pointer items-center justify-between gap-2 rounded-md py-1.5 pl-9 pr-2.5",
        isActive
          ? "bg-custom-sidebar-background-80"
          : "hover:bg-custom-sidebar-background-80",
      )}
    >
      <TreeGuide isLast={isLast} />
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
          <SessionActivityIndicator awaitingInput={isAwaitingInput} t={t} />
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
