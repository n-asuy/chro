import { type TranslationFunction, useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { type ForkWorkspace, forkTaskLatest } from "@/lib/fork-client";
import { revealInFinder } from "@/lib/project-client";
import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { ArchivePopover } from "@/session/components/archive-popover";
import { SessionActivityIndicator } from "@/session/components/session-activity-indicator";
import { SessionLeadingMarker } from "@/session/components/session-leading-marker";
import { formatRelativeTime } from "@/session/lib/relative-time";
import {
  SessionPreviewProvider,
  useSessionPreviewTrigger,
} from "@/session/components/session-preview";
import {
  type GroupLabels,
  type SessionGroup,
  groupSessions,
  isInboxSession,
  sortPinnedSessions,
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
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
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
  ExternalLink,
  GitBranch,
  Pin,
  PinOff,
  Plus,
  Search,
  SquarePen,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAllProjects } from "../../hooks/use-all-projects";
import { useNewChat } from "../../hooks/use-new-chat";
import { useOpenSession } from "../../hooks/use-open-session";
import { usePinnedSessions } from "../../hooks/use-pinned-sessions";
import { useProjectNavigation } from "../../hooks/use-project-navigation";
import { useCommandPaletteStore } from "../../state/command-palette-store";
import { useLayoutStore } from "../../state/layout-store";
import {
  type OpenProjectTab,
  useOpenProjectsStore,
} from "../../state/open-projects-store";
import { KeyboardHint } from "../keyboard-hint";
import { ProjectSwitcherDropdown } from "../project-switcher-dropdown";

const ICON_BUTTON_CLASS =
  "inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-custom-sidebar-text-300 transition hover:bg-foreground/5 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40";

interface ArchivedSessionSummary {
  id: string;
  title: string;
  archivedAt: string;
}

const EMPTY_ARCHIVED: readonly ArchivedSessionSummary[] = [];

/**
 * How sessions are ordered inside each group. `name-asc`/`name-desc` order by
 * title; `recent` orders by most-recent activity (and orders the project
 * sections by their latest session too).
 */
type SortMode = "name-asc" | "name-desc" | "recent";

const DEFAULT_SORT_MODE: SortMode = "recent";
const SORT_MODE_STORAGE_KEY = "workspace-layout:projects-sort-mode:v1";

const SORT_OPTIONS: readonly {
  mode: SortMode;
  labelKey: "sortProjectsAsc" | "sortProjectsDesc" | "sortProjectsRecent";
}[] = [
  { mode: "recent", labelKey: "sortProjectsRecent" },
  { mode: "name-asc", labelKey: "sortProjectsAsc" },
  { mode: "name-desc", labelKey: "sortProjectsDesc" },
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
 * Left-dock panel with a fixed three-section information architecture:
 *
 * - **Pinned** (top): sessions the user pinned, lifted out of their home
 *   section and floated by urgency. Only rendered when non-empty.
 * - **Projects** (middle): git-repo projects, each a collapsible section with
 *   its sessions nested underneath.
 * - **Chats** (bottom): non-project, folder-backed general chats, listed flat
 *   directly under the section. The backing project stays nameless in the UI.
 *
 * A single cross-project stream feeds all three; membership is decided by the
 * owning project (scratch -> Chats, otherwise -> Projects) and by the pin set.
 */
export function ProjectsDockPanel() {
  const { t } = useLanguage();
  const handleNewChat = useNewChat();

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
  const { isArchived, archiveSession } = useArchivedSessions();
  const { pins, isPinned, togglePin } = usePinnedSessions();
  const openSession = useOpenSession();
  const activeTaskKey = useFocusedSessionTaskKey();

  // Reveal the active session after a navigation (palette jump, deep link):
  // scroll its row into view once per focused-session change. Runs on every
  // render but is gated by the ref, so it also catches the row appearing late
  // (list still streaming in at mount) while stream reorders never re-scroll.
  // A row inside a collapsed group stays unrendered and is deliberately left
  // alone. `nearest` keeps an already-visible row still.
  const sessionListRef = useRef<HTMLDivElement>(null);
  const revealedTaskKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTaskKey) {
      revealedTaskKeyRef.current = null;
      return;
    }
    if (revealedTaskKeyRef.current === activeTaskKey) return;
    const row = sessionListRef.current?.querySelector(
      '[role="option"][aria-selected="true"]',
    );
    if (!row) return;
    revealedTaskKeyRef.current = activeTaskKey;
    row.scrollIntoView({ block: "nearest" });
  });

  // Reveal the active project's section after a navigation that lands on its
  // overview with no active session (Command+K project pick, deep link) — the
  // symmetric counterpart to the session-row reveal above. Skipped while a
  // session is active, since that row lives inside this same section and its
  // own reveal already brings the section into view. Same once-per-change
  // gate. Aligns the header to the top (`start`), not `nearest`: the header is
  // the top of its section, so `nearest` would park it at the bottom edge with
  // the section's sessions scrolled off-screen below it.
  const activeProjectId = useLayoutStore((s) => s.projectId);
  const revealedProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeTaskKey || !activeProjectId) {
      revealedProjectIdRef.current = null;
      return;
    }
    if (revealedProjectIdRef.current === activeProjectId) return;
    const header = sessionListRef.current?.querySelector(
      `[data-project-id="${activeProjectId}"]`,
    );
    if (!header) return;
    revealedProjectIdRef.current = activeProjectId;
    header.scrollIntoView({ block: "start" });
  });

  // Fork lands the user in the new session straight away: they asked to
  // continue, and the fork only becomes real once they write the first turn.
  const forkSession = useCallback(
    async (task: StoredTask, workspace?: ForkWorkspace) => {
      try {
        const result = await forkTaskLatest(task.id, workspace);
        openSession({
          ...task,
          id: result.task.id,
          slug: result.task.slug,
          title: result.task.title,
          active_session_id: null,
        });
      } catch (error) {
        console.error("[projects-panel] fork failed", error);
      }
    },
    [openSession],
  );

  // One source of truth: the cross-project stream with optimistic rows overlaid.
  // Archived sessions are split off (hidden from the list but still restorable
  // from their project's archive popover).
  const merged = useMemo(
    () => applyPendingSubmissionGroupsToTasks(streamTasks, pendingGroups),
    [streamTasks, pendingGroups],
  );

  const openProjectIds = useMemo(
    () => new Set(openProjects.map((project) => project.id)),
    [openProjects],
  );

  // The hidden project(s) backing scratch chats: their sessions stay visible
  // without the project being open, and they surface under the Chats section
  // rather than as a named project.
  const scratchProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, project] of Object.entries(projectsById)) {
      if (project?.isGeneral) ids.add(id);
    }
    return ids;
  }, [projectsById]);

  // Scope the inbox to sessions whose project is open or scratch. Sessions from
  // projects the user removed from the sidebar drop out instead of resurfacing.
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

  // Pinned lifts sessions out of their home section, so the Projects and Chats
  // partitions below both exclude pinned ids.
  const pinnedTasks = useMemo(
    () =>
      sortPinnedSessions(
        visibleSorted.filter((t) => isPinned(t.id)),
        pins,
      ),
    [visibleSorted, isPinned, pins],
  );

  const chatTasks = useMemo(
    () =>
      visibleSorted.filter(
        (task) => scratchProjectIds.has(task.project_id) && !isPinned(task.id),
      ),
    [visibleSorted, scratchProjectIds, isPinned],
  );

  const projectTasks = useMemo(
    () =>
      visibleSorted.filter(
        (task) => !scratchProjectIds.has(task.project_id) && !isPinned(task.id),
      ),
    [visibleSorted, scratchProjectIds, isPinned],
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

  // Origin label shown on a pinned row so its home section stays legible: the
  // project name for a repo task, the Chats label for a scratch chat.
  const originLabelFor = useCallback(
    (task: StoredTask): string | null =>
      scratchProjectIds.has(task.project_id)
        ? t("chatsSection")
        : projectNames[task.project_id] ?? null,
    [scratchProjectIds, projectNames, t],
  );

  // Open (non-scratch) projects always render as sections, latest-active first
  // under `recent`, even when they currently have no sessions.
  const orderedProjects = useMemo(() => {
    const lastActivity: Record<string, number> = {};
    for (const task of projectTasks) {
      const at = new Date(task.updated_at).getTime();
      lastActivity[task.project_id] = Math.max(
        lastActivity[task.project_id] ?? 0,
        Number.isNaN(at) ? 0 : at,
      );
    }
    return openProjects
      .filter((project) => !scratchProjectIds.has(project.id))
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
  }, [openProjects, projectTasks, sortMode, scratchProjectIds]);

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

  const projectGroups = useMemo(
    () =>
      groupSessions({
        tasks: projectTasks,
        mode: "project",
        projectNames,
        pinnedProjects: orderedProjects,
        now: Date.now(),
        labels,
      }),
    [projectTasks, projectNames, orderedProjects, labels],
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
      const allCollapsed = projectGroups.every((group) => prev.has(group.key));
      if (allCollapsed) return new Set();
      return new Set(projectGroups.map((group) => group.key));
    });
  }, [projectGroups]);

  const hasExpanded = projectGroups.some((group) => !collapsed.has(group.key));
  const hasAnyContent =
    pinnedTasks.length > 0 ||
    projectGroups.length > 0 ||
    chatTasks.length > 0 ||
    openProjects.length > 0;

  return (
    <SessionPreviewProvider>
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-1">
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
                    disabled={!hasExpanded && projectGroups.length === 0}
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
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={sessionListRef}
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          >
            {isLoading && !hasAnyContent ? (
              <div className="flex items-center gap-2 py-1.5 pl-2.5 text-xs text-custom-sidebar-text-400">
                <LoadingDot isLoading className="h-3 w-3" />
              </div>
            ) : (
              <>
                {pinnedTasks.length > 0 ? (
                  <div className="mb-1">
                    <SectionLabel>{t("pinnedSection")}</SectionLabel>
                    <div className="flex flex-col gap-0.5">
                      {pinnedTasks.map((task) => (
                        <SessionRowContainer
                          key={task.id}
                          task={task}
                          indented={false}
                          showProject
                          projectName={originLabelFor(task)}
                          isPinned
                          onTogglePin={() => togglePin(task.id)}
                          isActive={
                            activeTaskKey === task.id ||
                            activeTaskKey === task.slug
                          }
                          onOpen={() => openSession(task)}
                          onArchive={() => archiveSession(task)}
                          onFork={(workspace) => void forkSession(task, workspace)}
                          canUseWorktree={!scratchProjectIds.has(task.project_id)}
                          t={t}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mb-1">
                  <SectionLabel>{t("projects")}</SectionLabel>
                  {projectGroups.length === 0 ? (
                    <div className="py-1.5 pl-2.5 text-sm text-custom-sidebar-text-400">
                      {t("noProjectsYet")}
                    </div>
                  ) : (
                    projectGroups.map((group) => (
                      <SessionGroupSection
                        key={group.key}
                        group={group}
                        collapsed={collapsed.has(group.key)}
                        onToggle={() => toggleCollapsed(group.key)}
                        project={
                          group.projectId
                            ? openProjectsById[group.projectId] ?? null
                            : null
                        }
                        archived={
                          group.projectId
                            ? archivedByProject[group.projectId] ??
                              EMPTY_ARCHIVED
                            : EMPTY_ARCHIVED
                        }
                        isPinned={isPinned}
                        onTogglePin={togglePin}
                        t={t}
                      />
                    ))
                  )}
                </div>

                <div className="mb-1">
                  <SectionLabel>{t("chatsSection")}</SectionLabel>
                  {chatTasks.length === 0 ? (
                    <div className="py-1.5 pl-2.5 text-sm text-custom-sidebar-text-400">
                      {t("noChats")}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {chatTasks.map((task) => (
                        <SessionRowContainer
                          key={task.id}
                          task={task}
                          indented={false}
                          showProject={false}
                          projectName={null}
                          isPinned={isPinned(task.id)}
                          onTogglePin={() => togglePin(task.id)}
                          isActive={
                            activeTaskKey === task.id ||
                            activeTaskKey === task.slug
                          }
                          onOpen={() => openSession(task)}
                          onArchive={() => archiveSession(task)}
                          onFork={(workspace) => void forkSession(task, workspace)}
                          canUseWorktree={!scratchProjectIds.has(task.project_id)}
                          t={t}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
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

/** Muted top-level section heading (Pinned / Projects / Chats). */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="select-none px-2.5 pt-3 pb-1 text-xs font-medium text-custom-sidebar-text-400">
      {children}
    </div>
  );
}

interface SessionGroupSectionProps {
  group: SessionGroup;
  collapsed: boolean;
  onToggle: () => void;
  /** The open-project tab when this is a project section for an open project. */
  project: OpenProjectTab | null;
  /** Archived sessions for this project (project sections only). */
  archived: readonly ArchivedSessionSummary[];
  isPinned: (taskId: string) => boolean;
  onTogglePin: (taskId: string) => void;
  t: TranslationFunction;
}

const SessionGroupSection = memo(function SessionGroupSection({
  group,
  collapsed,
  onToggle,
  project,
  archived,
  isPinned,
  onTogglePin,
  t,
}: SessionGroupSectionProps) {
  const activeTaskKey = useFocusedSessionTaskKey();
  const { archiveSession, restoreSession } = useArchivedSessions();
  const { activateProject, newSession } = useProjectNavigation();
  const closeProject = useOpenProjectsStore((s) => s.closeProject);
  const openSession = useOpenSession();

  const forkSession = useCallback(
    async (task: StoredTask, workspace?: ForkWorkspace) => {
      try {
        const result = await forkTaskLatest(task.id, workspace);
        openSession({
          ...task,
          id: result.task.id,
          slug: result.task.slug,
          title: result.task.title,
          active_session_id: null,
        });
      } catch (error) {
        console.error("[projects-panel] fork failed", error);
      }
    },
    [openSession],
  );

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

      {collapsed ? null : (
        <div className="tree-group-reveal mt-0.5 flex flex-col gap-0.5">
          {group.tasks.length === 0 ? (
            <div className="py-1.5 pl-5 text-sm text-custom-sidebar-text-400">
              {t("noChats")}
            </div>
          ) : (
            group.tasks.map((task) => (
              <SessionRowContainer
                key={task.id}
                task={task}
                indented
                showProject={false}
                projectName={null}
                isPinned={isPinned(task.id)}
                onTogglePin={() => onTogglePin(task.id)}
                isActive={
                  activeTaskKey === task.id || activeTaskKey === task.slug
                }
                onOpen={() => openSession(task)}
                onArchive={() => archiveSession(task)}
                onFork={(workspace) => void forkSession(task, workspace)}
                canUseWorktree={project !== null}
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
      // Reveal target for the active-project scroll effect (a project opened
      // via Command+K / deep link lands on its overview with no active
      // session, so the session-row reveal can't surface it).
      data-project-id={group.projectId ?? undefined}
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

interface SessionRowContainerProps {
  task: StoredTask;
  indented: boolean;
  showProject: boolean;
  projectName: string | null;
  isPinned: boolean;
  onTogglePin: () => void;
  isActive: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onFork: (workspace?: ForkWorkspace) => void;
  /** Scratch chats have no repo, so there is no worktree to choose between and
   * the menu collapses to a single item. */
  canUseWorktree: boolean;
  t: TranslationFunction;
}

/**
 * Wraps a session row with its right-click menu (pin/unpin, archive). Open,
 * archive and active-state are resolved once per section by the caller and
 * passed in, so this stays a pure presentational wrapper.
 *
 * The trigger wraps `SessionRow` in a plain `<div>` rather than using
 * `asChild` directly on the component: Radix injects its ref and
 * `onContextMenu` onto the child element, and `SessionRow` (a component that
 * owns its own ref for hover-preview) would drop them, leaving right-click
 * dead. A real DOM node receives them cleanly.
 */
function SessionRowContainer(props: SessionRowContainerProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <SessionRow
            task={props.task}
            indented={props.indented}
            showProject={props.showProject}
            projectName={props.projectName}
            isActive={props.isActive}
            isPinned={props.isPinned}
            onTogglePin={props.onTogglePin}
            onOpen={props.onOpen}
            onArchive={props.onArchive}
            t={props.t}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-20 w-44 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
        <ContextMenuItem
          onSelect={props.onTogglePin}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
        >
          {props.isPinned ? (
            <PinOff className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Pin className="h-3.5 w-3.5 shrink-0" />
          )}
          <span>
            {props.isPinned ? props.t("unpinSession") : props.t("pinSession")}
          </span>
        </ContextMenuItem>
        {/* Continuing from a session row has no anchor to pick, so it always
            branches from the latest finished run. The only open question is
            where the copy works, and only a repo can answer it. */}
        {props.canUseWorktree ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100">
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              <span>{props.t("continueIn")}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="z-20 w-52 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
              <ContextMenuItem
                onSelect={() => props.onFork("same")}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <span>{props.t("continueInNewSession")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => props.onFork("new_worktree")}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <span>{props.t("continueInNewWorktree")}</span>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : (
          <ContextMenuItem
            onSelect={() => props.onFork()}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span>{props.t("continueInNewSession")}</span>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
        <ContextMenuItem
          onSelect={props.onArchive}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
        >
          <Archive className="h-3.5 w-3.5 shrink-0" />
          <span>{props.t("archive")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface SessionRowProps {
  task: StoredTask;
  indented: boolean;
  showProject: boolean;
  projectName: string | null;
  isActive: boolean;
  isPinned: boolean;
  onTogglePin: () => void;
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
  isPinned,
  onTogglePin,
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
          {/* One sub-line, one fact. The run outcome wins: it says what the
              session actually did, which no other row element carries.
              Provenance is next (a forked row is only legible if you can see
              what it continues; also the only signal before the first run),
              then the project name for pinned rows. */}
          {task.last_summary ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {task.last_summary}
            </span>
          ) : task.forked_from_title ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {t("forkedFrom", { title: task.forked_from_title })}
            </span>
          ) : task.delegated_from_title ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {t("delegatedFrom", { title: task.delegated_from_title })}
            </span>
          ) : showProject && projectName ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {projectName}
            </span>
          ) : null}
        </span>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        {isRunning ? (
          <span className="inline-flex items-center group-hover/row:hidden">
            <SessionActivityIndicator awaitingInput={isAwaitingInput} t={t} />
          </span>
        ) : (
          <span className="text-sm text-custom-sidebar-text-400 group-hover/row:hidden">
            {formatRelativeTime(task.updated_at)}
          </span>
        )}
        <span className="hidden items-center gap-1.5 group-hover/row:flex">
          <button
            type="button"
            aria-label={isPinned ? t("unpinSession") : t("pinSession")}
            title={isPinned ? t("unpinSession") : t("pinSession")}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
            className="flex items-center justify-center rounded p-0.5 text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100"
          >
            <Pin className={cn("h-3.5 w-3.5", isPinned && "fill-current")} />
          </button>
          <button
            type="button"
            aria-label="Archive session"
            onClick={(event) => {
              event.stopPropagation();
              onArchive();
            }}
            className="flex items-center justify-center rounded p-0.5 text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100"
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        </span>
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
