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
import type { TaskStatusDotKind } from "@/session/domain/task-read-state";
import {
  type GroupLabels,
  type SessionGroup,
  type SessionGroupMode,
  groupSessions,
  isInboxSession,
  isSessionGroupMode,
} from "@/session/domain/session-grouping";
import { applyPendingSubmissionGroupsToTasks } from "@/session/domain/session-task-state";
import {
  useArchivedSessions,
  useInboxTasksStream,
  useMarkViewedWhenActive,
  useTaskStatusDot,
} from "@/session/hooks";
import { useAllPendingSessionSubmissions } from "@/session/state/pending-session-submissions-store";
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
import {
  Archive,
  ArrowDownUp,
  Check,
  ChevronRight,
  ChevronsDownUp,
  Circle,
  ExternalLink,
  Group,
  Plus,
  Search,
  SquarePen,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAllProjects } from "../../hooks/use-all-projects";
import { useNewChat } from "../../hooks/use-new-chat";
import { useOpenSession } from "../../hooks/use-open-session";
import { useProjectNavigation } from "../../hooks/use-project-navigation";
import { useCommandPaletteStore } from "../../state/command-palette-store";
import { useLayoutStore } from "../../state/layout-store";
import {
  type OpenProjectTab,
  useOpenProjectsStore,
} from "../../state/open-projects-store";
import { KeyboardHint } from "../keyboard-hint";
import { ProjectSwitcherDropdown } from "../project-switcher-dropdown";
import { ViewFade } from "../view-fade";

const ICON_BUTTON_CLASS =
  "inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-custom-sidebar-text-300 transition hover:bg-foreground/5 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40";

interface ArchivedSessionSummary {
  id: string;
  title: string;
  archivedAt: string;
}

const EMPTY_ARCHIVED: readonly ArchivedSessionSummary[] = [];

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
 * How sessions are ordered inside each group. `name-asc`/`name-desc` order by
 * title; `recent` orders by most-recent activity (and, in project grouping,
 * orders the project sections by their latest session too).
 */
type SortMode = "name-asc" | "name-desc" | "recent";

const DEFAULT_SORT_MODE: SortMode = "recent";
const SORT_MODE_STORAGE_KEY = "workspace-layout:projects-sort-mode:v1";
const GROUP_MODE_STORAGE_KEY = "workspace-layout:session-group-mode:v1";
const DEFAULT_GROUP_MODE: SessionGroupMode = "project";

const SORT_OPTIONS: readonly {
  mode: SortMode;
  labelKey: "sortProjectsAsc" | "sortProjectsDesc" | "sortProjectsRecent";
}[] = [
  { mode: "recent", labelKey: "sortProjectsRecent" },
  { mode: "name-asc", labelKey: "sortProjectsAsc" },
  { mode: "name-desc", labelKey: "sortProjectsDesc" },
];

const GROUP_OPTIONS: readonly {
  mode: SessionGroupMode;
  labelKey: "groupByNone" | "groupByProject" | "groupByStatus" | "groupByDate";
}[] = [
  { mode: "none", labelKey: "groupByNone" },
  { mode: "project", labelKey: "groupByProject" },
  { mode: "status", labelKey: "groupByStatus" },
  { mode: "date", labelKey: "groupByDate" },
];

const isSortMode = (value: unknown): value is SortMode =>
  value === "name-asc" || value === "name-desc" || value === "recent";

function usePersistedChoice<T>(
  storageKey: string,
  fallback: T,
  guard: (value: unknown) => value is T,
): [T, (next: T) => void] {
  const read = useCallback((): T => {
    const value = getUiValue<unknown>(storageKey);
    return guard(value) ? value : fallback;
  }, [storageKey, fallback, guard]);

  const [choice, setChoice] = useState<T>(read);
  const [userChose, setUserChose] = useState(false);

  const set = useCallback(
    (next: T) => {
      setUserChose(true);
      setChoice(next);
      setUiValue(storageKey, next);
    },
    [storageKey],
  );

  // Hydrate from persisted UI state once it is ready, unless the user already
  // made an explicit choice this session.
  useEffect(() => {
    const hydrate = () => {
      if (!isUiStateReady()) return false;
      if (!userChose) setChoice(read());
      return true;
    };
    if (hydrate()) return;
    const id = window.setInterval(() => {
      if (hydrate()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [read, userChose]);

  return [choice, set];
}

function sortTasks(tasks: StoredTask[], mode: SortMode): StoredTask[] {
  const next = [...tasks];
  next.sort((a, b) => {
    if (mode === "recent") {
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    }
    const cmp = (a.title || "").localeCompare(b.title || "");
    return mode === "name-asc" ? cmp : -cmp;
  });
  return next;
}

/**
 * Left-dock panel: one flat, cross-project session list folded into collapsible
 * sections by a chosen axis (none / project / status / date). Project is just
 * one grouping option rather than a structural container — the former "inbox"
 * is simply "group by none", and the former project tree is "group by project".
 */
export function ProjectsDockPanel() {
  const { t } = useLanguage();
  const handleNewChat = useNewChat();

  const [groupMode, setGroupMode] = usePersistedChoice(
    GROUP_MODE_STORAGE_KEY,
    DEFAULT_GROUP_MODE,
    isSessionGroupMode,
  );
  const [sortMode, setSortMode] = usePersistedChoice(
    SORT_MODE_STORAGE_KEY,
    DEFAULT_SORT_MODE,
    isSortMode,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // The session-search palette is mounted globally (see SessionSearchPalette);
  // this button just flips its shared open state so ⌘K / ⌘P and the button
  // open the very same modal.
  const openPalette = useCommandPaletteStore((s) => s.openPalette);

  const openProjects = useOpenProjectsStore((s) => s.projects);
  const { tasks: streamTasks, isLoading } = useInboxTasksStream(true);
  const pendingGroups = useAllPendingSessionSubmissions();
  const projectsById = useAllProjects(true);
  const { isArchived } = useArchivedSessions();

  // One source of truth for every mode: the cross-project stream with optimistic
  // rows overlaid. Archived sessions are split off (hidden from the list but
  // still restorable from their project's archive popover).
  const merged = useMemo(
    () => applyPendingSubmissionGroupsToTasks(streamTasks, pendingGroups),
    [streamTasks, pendingGroups],
  );

  const openProjectIds = useMemo(
    () => new Set(openProjects.map((project) => project.id)),
    [openProjects],
  );

  // The hidden "General" project(s) backing scratch chats: their sessions stay
  // visible without the project being open, so removing a real project from the
  // sidebar can hide its sessions without also dropping general-purpose chats.
  const scratchProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, project] of Object.entries(projectsById)) {
      if (project?.isGeneral) ids.add(id);
    }
    return ids;
  }, [projectsById]);

  // Scope the inbox to sessions whose project is open or scratch. Sessions from
  // projects the user removed from the sidebar drop out instead of resurfacing
  // in a catch-all section at the bottom of the list.
  const visibleSorted = useMemo(
    () =>
      sortTasks(
        merged.filter(
          (task) =>
            !isArchived(task) &&
            isInboxSession(task, openProjectIds, scratchProjectIds),
        ),
        sortMode,
      ),
    [merged, isArchived, sortMode, openProjectIds, scratchProjectIds],
  );

  const archivedByProject = useMemo(() => {
    const byProject: Record<
      string,
      { id: string; title: string; archivedAt: string }[]
    > = {};
    for (const task of merged) {
      if (!isArchived(task)) continue;
      const list = byProject[task.project_id] ?? [];
      byProject[task.project_id] = list;
      list.push({
        id: task.id,
        title: task.title,
        archivedAt: task.updated_at,
      });
    }
    return byProject;
  }, [merged, isArchived]);

  const projectNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const project of openProjects) names[project.id] = project.name;
    for (const id of Object.keys(projectsById)) {
      names[id] = projectsById[id]?.name ?? names[id];
    }
    return names;
  }, [openProjects, projectsById]);

  // Project sections render in sort order, latest-active first under `recent`.
  const pinnedProjects = useMemo(() => {
    const lastActivity: Record<string, number> = {};
    for (const task of visibleSorted) {
      const at = new Date(task.updated_at).getTime();
      lastActivity[task.project_id] = Math.max(
        lastActivity[task.project_id] ?? 0,
        Number.isNaN(at) ? 0 : at,
      );
    }
    return [...openProjects]
      .sort((a, b) => {
        if (sortMode === "recent") {
          const diff = (lastActivity[b.id] ?? 0) - (lastActivity[a.id] ?? 0);
          if (diff !== 0) return diff;
          return a.name.localeCompare(b.name);
        }
        const cmp = a.name.localeCompare(b.name);
        return sortMode === "name-desc" ? -cmp : cmp;
      })
      .map((project) => ({ id: project.id, name: project.name }));
  }, [openProjects, visibleSorted, sortMode]);

  const labels = useMemo<GroupLabels>(
    () => ({
      state: {
        needs_input: t("stateNeedsInput"),
        running: t("stateRunning"),
        pending: t("statePending"),
        completed: t("stateCompleted"),
        failed: t("stateFailed"),
        cancelled: t("stateCancelled"),
      },
      dateBucket: {
        today: t("dateToday"),
        yesterday: t("dateYesterday"),
        last7: t("dateLast7"),
        last30: t("dateLast30"),
        older: t("dateOlder"),
      },
      unknownProject: t("unknownProject"),
    }),
    [t],
  );

  const groups = useMemo(
    () =>
      groupSessions({
        tasks: visibleSorted,
        mode: groupMode,
        projectNames,
        pinnedProjects,
        now: Date.now(),
        labels,
      }),
    [visibleSorted, groupMode, projectNames, pinnedProjects, labels],
  );

  const openProjectsById = useMemo(() => {
    const byId: Record<string, OpenProjectTab> = {};
    for (const project of openProjects) byId[project.id] = project;
    return byId;
  }, [openProjects]);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed((prev) => {
      // If everything is already collapsed, expand all instead (toggle).
      const allCollapsed = groups.every((group) => prev.has(group.key));
      if (allCollapsed) return new Set();
      return new Set(groups.map((group) => group.key));
    });
  }, [groups]);

  const hasExpanded = groups.some((group) => !collapsed.has(group.key));
  // Only `project` mode keeps showing (project headers) when there are no
  // sessions but projects are open; the other modes have nothing to render.
  const isEmpty =
    visibleSorted.length === 0 &&
    (groupMode !== "project" || pinnedProjects.length === 0);

  return (
    <SessionPreviewProvider>
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-1">
            <ChoiceDropdown
              ariaLabel={t("groupBy")}
              title={t("groupBy")}
              icon={<Group className="h-4 w-4" />}
              current={groupMode}
              options={GROUP_OPTIONS.map((o) => ({
                value: o.mode,
                label: t(o.labelKey),
              }))}
              onSelect={setGroupMode}
            />
            <ChoiceDropdown
              ariaLabel={t("sortProjects")}
              title={t("sortProjects")}
              icon={<ArrowDownUp className="h-4 w-4" />}
              current={sortMode}
              options={SORT_OPTIONS.map((o) => ({
                value: o.mode,
                label: t(o.labelKey),
              }))}
              onSelect={setSortMode}
            />
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("collapseAllProjects")}
                    onClick={collapseAll}
                    disabled={!hasExpanded && groups.length === 0}
                    className={ICON_BUTTON_CLASS}
                  >
                    <ChevronsDownUp className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center">
                  {t("collapseAllProjects")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("openCommandPalette")}
                  onClick={openPalette}
                  className={ICON_BUTTON_CLASS}
                >
                  <Search className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="center"
                className="flex items-center gap-2"
              >
                <span>{t("openCommandPalette")}</span>
                <KeyboardHint keys={["mod", "K"]} />
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="shrink-0 px-2 pb-1">
          <button
            type="button"
            onClick={handleNewChat}
            className="group flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-custom-sidebar-text-300 transition hover:bg-foreground/5 hover:text-custom-sidebar-text-100"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              {t("newChat")}
            </span>
            <KeyboardHint
              keys={["mod", "N"]}
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>
        </div>
        <ViewFade viewKey={groupMode} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {isLoading && isEmpty ? (
              <div className="flex items-center gap-2 py-1.5 pl-2.5 text-xs text-custom-sidebar-text-400">
                <LoadingDot isLoading className="h-3 w-3" />
              </div>
            ) : isEmpty ? (
              <div className="py-1.5 pl-2.5 text-sm text-custom-sidebar-text-400">
                {t("noSessions")}
              </div>
            ) : (
              groups.map((group) => (
                <SessionGroupSection
                  key={group.key}
                  group={group}
                  mode={groupMode}
                  collapsed={collapsed.has(group.key)}
                  onToggle={() => toggleCollapsed(group.key)}
                  project={
                    group.projectId
                      ? openProjectsById[group.projectId] ?? null
                      : null
                  }
                  archived={
                    group.projectId
                      ? archivedByProject[group.projectId] ?? EMPTY_ARCHIVED
                      : EMPTY_ARCHIVED
                  }
                  t={t}
                />
              ))
            )}
          </div>
        </ViewFade>
      </div>
    </SessionPreviewProvider>
  );
}

interface ChoiceDropdownProps<T extends string> {
  ariaLabel: string;
  title: string;
  icon: ReactNode;
  current: T;
  options: { value: T; label: string }[];
  onSelect: (value: T) => void;
}

function ChoiceDropdown<T extends string>({
  ariaLabel,
  title,
  icon,
  current,
  options,
  onSelect,
}: ChoiceDropdownProps<T>) {
  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={ariaLabel}
                  className={ICON_BUTTON_CLASS}
                >
                  {icon}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom" className="w-48">
                <DropdownMenuLabel className="-mx-1 -mt-1 mb-1 border-border/40 border-b px-3 py-1.5 font-normal text-[11px] text-muted-foreground">
                  {title}
                </DropdownMenuLabel>
                {options.map((option) => {
                  const isActive = option.value === current;
                  return (
                    <DropdownMenuItem
                      key={option.value}
                      onSelect={() => onSelect(option.value)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-1 text-[13px]",
                        isActive && "bg-muted text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {option.label}
                      </span>
                      {isActive ? (
                        <Check className="h-3.5 w-3.5 shrink-0" />
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          {title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface SessionGroupSectionProps {
  group: SessionGroup;
  mode: SessionGroupMode;
  collapsed: boolean;
  onToggle: () => void;
  /** The open-project tab when this is a project section for an open project. */
  project: OpenProjectTab | null;
  /** Archived sessions for this project (project sections only). */
  archived: readonly ArchivedSessionSummary[];
  t: TranslationFunction;
}

const SessionGroupSection = memo(function SessionGroupSection({
  group,
  mode,
  collapsed,
  onToggle,
  project,
  archived,
  t,
}: SessionGroupSectionProps) {
  const activeTaskKey = useFocusedSessionTaskKey();
  const { archiveSession, restoreSession } = useArchivedSessions();
  const { activateProject, newSession } = useProjectNavigation();
  const closeProject = useOpenProjectsStore((s) => s.closeProject);
  const projectsById = useAllProjects(true);
  const openSession = useOpenSession();

  // `none` is the flat list: no header, just rows (the former inbox).
  const headerless = mode === "none";

  const handleHeaderClick = () => {
    if (project) {
      activateProject(project);
      if (collapsed) onToggle();
      return;
    }
    onToggle();
  };

  return (
    <div className="mb-0.5">
      {headerless ? null : (
        <GroupHeader
          group={group}
          collapsed={collapsed}
          project={project}
          archived={archived}
          onToggleChevron={onToggle}
          onHeaderClick={handleHeaderClick}
          onNewSession={project ? () => newSession(project) : undefined}
          onRestore={restoreSession}
          onRevealInFinder={
            project
              ? () => {
                  revealInFinder(project.id, "/").catch((error) => {
                    console.warn(
                      "[projects-panel] Failed to reveal in finder:",
                      error,
                    );
                  });
                }
              : undefined
          }
          onRemove={project ? () => closeProject(project.id) : undefined}
          t={t}
        />
      )}

      {collapsed ? null : (
        <div
          className={cn(
            "flex flex-col gap-0.5",
            headerless ? undefined : "tree-group-reveal mt-0.5",
          )}
        >
          {group.tasks.length === 0 ? (
            <div
              className={cn(
                "py-1.5 text-sm text-custom-sidebar-text-400",
                headerless ? "pl-2.5" : "pl-5",
              )}
            >
              {t("noChats")}
            </div>
          ) : (
            group.tasks.map((task) => (
              <SessionRow
                key={task.id}
                task={task}
                indented={!headerless}
                showProject={mode !== "project"}
                projectName={
                  projectsById[task.project_id]?.name ??
                  (task.project_id || null)
                }
                isActive={
                  activeTaskKey === task.id || activeTaskKey === task.slug
                }
                onOpen={() => openSession(task)}
                onArchive={() => archiveSession(task)}
                t={t}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
});

interface GroupHeaderProps {
  group: SessionGroup;
  collapsed: boolean;
  project: OpenProjectTab | null;
  archived: readonly ArchivedSessionSummary[];
  onToggleChevron: () => void;
  onHeaderClick: () => void;
  onNewSession?: () => void;
  onRestore: (taskId: string) => void;
  onRevealInFinder?: () => void;
  onRemove?: () => void;
  t: TranslationFunction;
}

function GroupHeader({
  group,
  collapsed,
  project,
  archived,
  onToggleChevron,
  onHeaderClick,
  onNewSession,
  onRestore,
  onRevealInFinder,
  onRemove,
  t,
}: GroupHeaderProps) {
  const stop = (event: ReactMouseEvent) => event.stopPropagation();

  const header = (
    <div
      role="treeitem"
      aria-expanded={!collapsed}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: role="treeitem" requires keyboard focus for Enter/Space activation
      tabIndex={0}
      onClick={onHeaderClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onHeaderClick();
        }
      }}
      title={project?.workspacePath ?? group.label}
      className={cn(
        "group flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 transition-colors",
        "text-custom-sidebar-text-200 hover:bg-foreground/5",
      )}
    >
      <button
        type="button"
        aria-label={collapsed ? "Expand" : "Collapse"}
        onClick={(event) => {
          stop(event);
          onToggleChevron();
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
      <span className="min-w-0 flex-1 truncate text-sm">{group.label}</span>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
        {archived.length > 0 ? (
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
            archivedSessions={archived as ArchivedSessionSummary[]}
            onRestore={onRestore}
          />
        ) : null}
        {onNewSession ? (
          <button
            type="button"
            aria-label={t("newChat")}
            onClick={(event) => {
              stop(event);
              onNewSession();
            }}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </span>
    </div>
  );

  // Only open-project sections get the management context menu.
  if (!project) return header;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent className="z-20 w-52 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
        <ContextMenuItem
          onSelect={onRevealInFinder}
          disabled={!project.workspacePath}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span>{t("revealInFinder")}</span>
        </ContextMenuItem>
        <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
        <ContextMenuItem
          onSelect={onRemove}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
        >
          <X className="h-3.5 w-3.5 shrink-0" />
          <span>{t("removeProjectFromSidebar")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Leading status marker rendered before every session title so the list keeps
 * a consistent left rail: a quiet hollow bullet by default, a solid blue
 * bullet for an unread completed run, and an amber warning glyph for an unread
 * failure.
 */
function SessionLeadingMarker({
  kind,
  t,
}: {
  kind: TaskStatusDotKind;
  t: TranslationFunction;
}) {
  if (kind === "failed") {
    return (
      <TriangleAlert
        role="status"
        aria-label={t("sessionFailedUnread")}
        className="size-3 text-amber-500"
      />
    );
  }
  if (kind === "completed") {
    return (
      <Circle
        role="status"
        aria-label={t("sessionCompletedUnread")}
        className="size-2.5 fill-[#307BD0] text-[#307BD0]"
      />
    );
  }
  // Idle, running, or already-viewed: a decorative hollow bullet.
  return (
    <Circle
      aria-hidden="true"
      className="size-2.5 text-custom-sidebar-text-400"
    />
  );
}

interface SessionRowProps {
  task: StoredTask;
  indented: boolean;
  showProject: boolean;
  projectName: string | null;
  isActive: boolean;
  onOpen: () => void;
  onArchive: () => void;
  t: TranslationFunction;
}

function SessionRow({
  task,
  indented,
  showProject,
  projectName,
  isActive,
  onOpen,
  onArchive,
  t,
}: SessionRowProps) {
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
        "group/row flex cursor-pointer items-center justify-between gap-2 rounded-md py-1.5 transition-colors",
        indented ? "pl-5 pr-2.5" : "px-2.5",
        isActive
          ? "bg-foreground/5 text-custom-sidebar-text-100"
          : "hover:bg-foreground/5",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="flex w-4 shrink-0 items-center justify-center">
          <SessionLeadingMarker kind={dotKind} t={t} />
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
          {showProject && projectName ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {projectName}
            </span>
          ) : null}
        </span>
      </div>
      <span className="flex shrink-0 items-center">
        {isRunning ? (
          <span className="inline-flex items-center group-hover/row:hidden">
            <SessionActivityIndicator awaitingInput={isAwaitingInput} t={t} />
          </span>
        ) : (
          <span className="text-sm text-custom-sidebar-text-400 group-hover/row:hidden">
            {formatRelativeTime(task.updated_at)}
          </span>
        )}
        <button
          type="button"
          aria-label="Archive session"
          onClick={(event) => {
            event.stopPropagation();
            onArchive();
          }}
          className="hidden items-center justify-center rounded p-0.5 text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100 group-hover/row:flex"
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

/**
 * Raw focused-session task identifier (slug or id) for the bound layout, or
 * null when the focused tab isn't a session.
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
