import { useOptionalProjectContext } from "@/files/context/project-context";
import { useLanguage } from "@/i18n";
import { taskApi } from "@/kanban/api/task-api";
import {
  AddTaskPanel,
  type AddTaskPayload,
  type AddTaskSubmitOptions,
} from "@/kanban/components/add-task-panel";
import { useOptionalWorkspaceBoardContext } from "@/kanban/providers";
import { cn } from "@/lib/cn";
import { isUuidIdentifier } from "@/lib/uuid";
import {
  type RecentWorkspace,
  getRecentWorkspaces,
  normalizePathForCompare,
  touchRecentWorkspace,
} from "@/lib/workspace-history";
import { useGlobalSearch } from "@/search/global-search-provider";
import { useProjectTasksStream } from "@/session/hooks/use-project-tasks-stream";
import { useSettingsModal } from "@/settings/components/settings-modal-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  CheckCircle,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Disc,
  Folder,
  FolderOpen,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalAppRail } from "./app-rail-context";
import { AppSidebarItem } from "./app-sidebar-item";

const isPathActive = (pathname: string | null, target?: string) => {
  if (!pathname || !target) return false;
  if (target === "/") return pathname === "/";
  return pathname === target || pathname.startsWith(`${target}/`);
};

const RAIL_WIDTH_COMPACT = 52;
const RAIL_WIDTH_EXPANDED = 168;

const getFolderName = (path: string): string => {
  const normalized = path.replace(/\\+/g, "/").replace(/\/+$/, "");
  if (!normalized) return path;
  const segments = normalized.split("/");
  return segments[segments.length - 1] || normalized;
};

export const AppRail = () => {
  const { t } = useLanguage();
  const { projectId: routeProjectIdentifier } = useParams({
    strict: false,
  }) as { projectId?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { open: openSettingsModal, isOpen: isSettingsModalOpen } =
    useSettingsModal();
  const { open: openGlobalSearch, isOpen: isGlobalSearchOpen } =
    useGlobalSearch();
  const appRailContext = useOptionalAppRail();
  const expanded = appRailContext?.expanded ?? true;
  const navigate = useNavigate();
  const projectContext = useOptionalProjectContext();
  const apiProjectId =
    projectContext?.projectId ??
    (isUuidIdentifier(routeProjectIdentifier) ? routeProjectIdentifier : null);
  const navigationProjectId =
    projectContext?.projectSlug ?? routeProjectIdentifier ?? null;

  const { tasks: projectTasks } = useProjectTasksStream({
    projectId: apiProjectId,
  });
  const runningTaskCount = useMemo(
    () => projectTasks.filter((t) => t.active_session_id).length,
    [projectTasks],
  );

  const boardContext = useOptionalWorkspaceBoardContext();
  const workspacePath =
    boardContext?.workspacePath ?? projectContext?.workspacePath ?? null;

  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>(
    [],
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const workspaceSwitchRequestIdRef = useRef(0);

  // Add Task modal
  const [isAddTaskOpen, setIsAddTaskOpen] = useState(false);
  const defaultColumn = boardContext?.columns[0];
  const defaultColumnId = defaultColumn?.id;
  const canAddTask = Boolean(workspacePath);

  const handleAddTaskOpen = useCallback(() => {
    if (!canAddTask) return;
    setIsAddTaskOpen(true);
  }, [canAddTask]);

  const handleAddTaskSubmit = useCallback(
    async (payload: AddTaskPayload, options?: AddTaskSubmitOptions) => {
      // When board context is available (tasks page), use optimistic UI path
      if (boardContext && defaultColumnId) {
        boardContext.addIssueToColumn(defaultColumnId, payload.title, {
          summary: payload.summary,
          prompt: payload.prompt,
          runImmediately: options?.runImmediately,
          useWorktree: options?.useWorktree,
          executorProfileId: options?.executorProfileId,
          targetBranch: options?.targetBranch,
        });
        return;
      }

      // Otherwise, call API directly
      if (!workspacePath) return;
      try {
        const { id: resolvedProjectId } =
          await taskApi.ensureProject(workspacePath);
        const savedTask = await taskApi.create(
          resolvedProjectId,
          payload.prompt ? null : payload.title,
          payload.summary ?? null,
          payload.prompt ?? null,
        );
        if (options?.runImmediately) {
          await taskApi.startClaudeExecution(workspacePath, savedTask.id, {
            useWorktree: options.useWorktree,
            executorProfileId: options.executorProfileId,
            targetBranch: options?.targetBranch,
          });
        }
      } catch (error) {
        console.error("[app-rail] Failed to create task via add-task", error);
      }
    },
    [boardContext, defaultColumnId, workspacePath],
  );

  useEffect(() => {
    if (workspacePath) {
      touchRecentWorkspace(workspacePath);
    }
  }, [workspacePath]);

  useEffect(() => {
    if (dropdownOpen) {
      setRecentWorkspaces(getRecentWorkspaces());
    }
  }, [dropdownOpen]);

  const filteredRecentWorkspaces = useMemo(() => {
    if (recentWorkspaces.length === 0) return [];
    if (!workspacePath) return recentWorkspaces;
    const normalizedCurrent = normalizePathForCompare(workspacePath);
    return recentWorkspaces.filter(
      (entry) => normalizePathForCompare(entry.path) !== normalizedCurrent,
    );
  }, [recentWorkspaces, workspacePath]);

  const handleNewProject = useCallback(() => {
    setDropdownOpen(false);
    navigate({ to: "/workspace" });
  }, [navigate]);

  const handleOpenRecent = useCallback(
    async (path: string) => {
      const requestId = ++workspaceSwitchRequestIdRef.current;
      setDropdownOpen(false);
      try {
        const { id, slug } = await taskApi.ensureProject(path);
        if (requestId !== workspaceSwitchRequestIdRef.current) {
          return;
        }
        if (
          slug === routeProjectIdentifier ||
          id === apiProjectId ||
          slug === navigationProjectId
        ) {
          return;
        }
        navigate({
          to: "/projects/$projectId/tasks",
          params: { projectId: slug },
        });
      } catch (error) {
        if (requestId !== workspaceSwitchRequestIdRef.current) {
          return;
        }
        console.error("[app-rail] Failed to open recent project", error);
      }
    },
    [apiProjectId, navigate, navigationProjectId, routeProjectIdentifier],
  );

  const workspaceLabel = workspacePath ? getFolderName(workspacePath) : "chro";

  const navItems = useMemo(() => {
    if (!navigationProjectId) return [];
    const projectBase = `/projects/${navigationProjectId}`;
    return [
      {
        id: "tasks",
        label: t("navTasks"),
        href: `${projectBase}/tasks`,
        icon: <CheckCircle size={18} />,
      },
      {
        id: "session",
        label: t("navSession"),
        href: `${projectBase}/session`,
        icon: <Disc size={18} />,
        badge: runningTaskCount,
      },
      {
        id: "files",
        label: t("navFiles"),
        href: `${projectBase}/files`,
        icon: <Folder size={18} />,
      },
    ].map((item) => {
      const active = isPathActive(pathname ?? null, item.href);
      return { ...item, isActive: active };
    });
  }, [navigationProjectId, pathname, t, runningTaskCount]);

  const layout = expanded ? "stacked" : "compact";
  const width = expanded ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COMPACT;

  return (
    <nav
      className="h-full flex-shrink-0 select-none transition-all ease-in-out duration-300 z-[26]"
      style={{ width: `${width}px` }}
    >
      <aside
        className={cn(
          "h-full flex flex-col pb-4 px-2",
          window.__CHRO_RUNTIME__?.platform === "darwin" ? "pt-6" : "pt-2",
        )}
      >
        {/* Top Actions */}
        <div className="flex flex-col gap-1 w-full">
          {/* Workspace Switcher */}
          <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-3 rounded-md hover:bg-custom-sidebar-background-90 transition-colors group",
                  expanded
                    ? "w-full px-2 py-1.5"
                    : "justify-center w-10 h-10 mx-auto",
                )}
                title={workspacePath ?? "Switch Workspace"}
              >
                <div className="w-5 h-5 rounded bg-custom-sidebar-background-80 text-custom-sidebar-text-200 flex items-center justify-center shrink-0 text-[10px] font-bold">
                  {workspaceLabel.charAt(0).toUpperCase()}
                </div>
                {expanded && (
                  <div className="flex items-center justify-between flex-1 min-w-0 overflow-hidden">
                    <span className="text-xs font-semibold text-custom-sidebar-text-200 truncate group-hover:text-custom-sidebar-text-100">
                      {workspaceLabel}
                    </span>
                    <ChevronDown
                      size={10}
                      className="text-custom-sidebar-text-400 group-hover:text-custom-sidebar-text-200"
                    />
                  </div>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="bottom"
              className="min-w-[220px]"
            >
              {filteredRecentWorkspaces.length > 0 && (
                <>
                  {filteredRecentWorkspaces.map((entry) => (
                    <DropdownMenuItem
                      key={entry.path}
                      onClick={() => void handleOpenRecent(entry.path)}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <FolderOpen className="size-3.5 text-custom-sidebar-text-400 shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-[12px] font-medium truncate">
                          {getFolderName(entry.path)}
                        </span>
                        <span className="text-[10px] text-custom-sidebar-text-400 truncate">
                          {entry.path}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onClick={handleNewProject}
                className="flex items-center gap-2 cursor-pointer"
              >
                <Plus className="size-3.5" />
                <span className="text-[12px] font-medium">New Project</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <AppSidebarItem
            layout={layout}
            label="Search"
            icon={<Search size={18} />}
            variant="button"
            onClick={openGlobalSearch}
            isActive={isGlobalSearchOpen}
          />
          <div className="relative">
            <AppSidebarItem
              layout={layout}
              label="Add Task"
              icon={<Plus size={18} />}
              variant="button"
              onClick={handleAddTaskOpen}
              isActive={isAddTaskOpen}
            />
            <AddTaskPanel
              isOpen={isAddTaskOpen && canAddTask}
              projectId={apiProjectId}
              onClose={() => setIsAddTaskOpen(false)}
              onSubmit={handleAddTaskSubmit}
            />
          </div>

          <div className="h-4" />

          {navItems.map((item) => (
            <AppSidebarItem key={item.id} {...item} layout={layout} />
          ))}
        </div>

        <div className="flex-1" />

        {/* Bottom Section */}
        <div className="flex flex-col gap-1 w-full">
          <AppSidebarItem
            layout={layout}
            label={t("navSettings")}
            icon={<Settings size={18} />}
            variant="button"
            onClick={openSettingsModal}
            isActive={isSettingsModalOpen}
          />

          {/* Compact Toggle */}
          <AppSidebarItem
            layout={layout}
            icon={
              expanded ? (
                <ChevronsLeft size={18} />
              ) : (
                <ChevronsRight size={18} />
              )
            }
            label="Collapse"
            variant="button"
            onClick={() => appRailContext?.toggleExpanded()}
          />
        </div>
      </aside>
    </nav>
  );
};
