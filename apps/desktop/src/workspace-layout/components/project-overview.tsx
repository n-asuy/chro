import { AgentLogo } from "@/components/agent-logo";
import { FolderSolidIcon } from "@/components/folder-icon";
import { useProjectContext } from "@/files/context/project-context";
import { slugOrId } from "@/lib/slug";
import {
  SessionPreviewProvider,
  useSessionPreviewTrigger,
} from "@/session/components/session-preview";
import { useOptionalProjectTasks } from "@/session/context/project-tasks-context";
import { useArchivedSessions } from "@/session/hooks";
import { formatRelativeTime } from "@/session/lib/relative-time";
import type { StoredTask } from "@/session/types";
import { Popover, PopoverContent, PopoverTrigger } from "@chro/ui/popover";
import { useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  ChevronDown,
  Images,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNewChat } from "../hooks/use-new-chat";
import { useProjectNavigation } from "../hooks/use-project-navigation";
import { useOpenProjectsStore } from "../state/open-projects-store";
import { useRightDockStore } from "../state/right-dock-store";
import { QuickAction } from "./quick-action";

/**
 * A recent-session launcher row that also reveals the shared hover preview of
 * its last conversation turn (same panel as the sidebar). The hover ref/handlers
 * wrap the {@link QuickAction} since that primitive does not forward a ref.
 */
function RecentSessionItem({
  task,
  onOpen,
}: {
  task: StoredTask;
  onOpen: () => void;
}) {
  const preview = useSessionPreviewTrigger(task);
  // Show the logo of the agent that actually ran the session, mirroring the
  // session tabs. Bound per task and memoized so the icon component keeps a
  // stable identity across hover-driven re-renders (no <img> remount/flicker).
  const agent = task.last_executor;
  const AgentIcon = useMemo(
    () =>
      function SessionAgentIcon({ className }: { className?: string }) {
        return <AgentLogo agent={agent} className={className} />;
      },
    [agent],
  );
  return (
    <div
      ref={preview.setAnchor}
      onPointerEnter={preview.hoverProps.onPointerEnter}
      onPointerLeave={preview.hoverProps.onPointerLeave}
      onPointerDown={preview.hoverProps.onPointerDown}
      className="min-w-0 [&>button]:w-full"
    >
      <QuickAction
        icon={AgentIcon}
        label={
          <span className={task.title?.trim() ? undefined : "opacity-60"}>
            {task.title?.trim() || "Untitled session"}
          </span>
        }
        trailing={
          <span className="shrink-0 text-[10px] tabular-nums opacity-50">
            {formatRelativeTime(task.updated_at)}
          </span>
        }
        onClick={onOpen}
      />
    </div>
  );
}

/** Most recent sessions surfaced on the overview. */
const RECENT_LIMIT = 8;

/**
 * Project home: the landing surface shown when switching to (or opening) a
 * project. Mirrors the empty-pane launcher design and lists the project's
 * most recent sessions so they can be resumed in one click, rather than
 * dropping straight into the last open tab.
 */
export function ProjectOverview() {
  const { project, projectSlug, isScratch } = useProjectContext();
  const navigate = useNavigate();
  const focusSearchPanel = useRightDockStore((s) => s.focusSearchPanel);
  const projectTasks = useOptionalProjectTasks();
  const { isArchived } = useArchivedSessions();
  const openProjects = useOpenProjectsStore((s) => s.projects);
  const { activateProject } = useProjectNavigation();
  const openChats = useNewChat();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");

  const handleSwitcherOpenChange = useCallback((next: boolean) => {
    setSwitcherOpen(next);
    if (!next) setSwitcherQuery("");
  }, []);

  const filteredProjects = useMemo(() => {
    const q = switcherQuery.trim().toLowerCase();
    if (!q) return openProjects;
    return openProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.workspacePath ?? "").toLowerCase().includes(q),
    );
  }, [openProjects, switcherQuery]);

  const recentSessions = useMemo(() => {
    const tasks = (projectTasks?.tasks ?? []).filter(
      (task) => !isArchived(task),
    );
    return [...tasks]
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )
      .slice(0, RECENT_LIMIT);
  }, [projectTasks?.tasks, isArchived]);

  const openNewSession = () => {
    if (!projectSlug) return;
    navigate({
      to: "/projects/$projectId/session",
      params: { projectId: projectSlug },
    });
  };

  const openSession = (task: StoredTask) => {
    if (!projectSlug) return;
    navigate({
      to: "/projects/$projectId/session/$taskId",
      params: { projectId: projectSlug, taskId: slugOrId(task) },
    });
  };

  const openSkills = () => {
    if (!projectSlug) return;
    navigate({
      to: "/projects/$projectId/skills",
      params: { projectId: projectSlug },
    });
  };

  const openGallery = () => {
    if (!projectSlug) return;
    navigate({
      to: "/projects/$projectId/gallery",
      params: { projectId: projectSlug },
    });
  };

  // Prefer the resolved project name; fall back to the route slug so the header
  // is present from first paint (avoids a vertical layout shift when the name
  // resolves), then refines to the proper name in place.
  const projectName = project?.name ?? projectSlug;

  return (
    <SessionPreviewProvider>
      <div className="h-full w-full overflow-auto text-muted-foreground">
        {/* `min-w-max` lets the centered column keep its full width when the pane
            is narrower than it: the row grows past the pane so the scroll
            container can scroll horizontally to reveal the otherwise-clipped
            edges, instead of cutting them off under `justify-center`. */}
        <div className="flex min-h-full min-w-max items-center justify-center px-6 py-10">
          <div className="flex w-72 shrink-0 flex-col gap-6 text-sm">
            {isScratch || projectName ? (
              // The header is always a searchable switcher: pick any project
              // open in the left panel, or jump back to Chats. Scratch keeps the
              // "General" project nameless by showing "Chats" as its label.
              <Popover
                open={switcherOpen}
                onOpenChange={handleSwitcherOpenChange}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="-mx-1 flex items-center gap-2 rounded-md px-1 py-0.5 text-left transition hover:bg-muted"
                  >
                    <FolderSolidIcon className="h-4 w-4 shrink-0 opacity-70" />
                    <h1 className="min-w-0 truncate text-base font-medium">
                      {isScratch ? "Chats" : projectName}
                    </h1>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  side="bottom"
                  sideOffset={6}
                  className="w-64 rounded-xl border border-border bg-popover p-0 shadow-sm"
                >
                  <div className="flex items-center gap-2 border-border border-b px-2.5 py-2">
                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    {/* Radix PopoverContent focuses its first focusable child
                        on open, so this input receives focus automatically. */}
                    <input
                      value={switcherQuery}
                      onChange={(event) => setSwitcherQuery(event.target.value)}
                      placeholder="Switch to project…"
                      className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1">
                    {/* Jump back to the general Chats overview. Hidden when
                        already there. */}
                    {!isScratch ? (
                      <button
                        type="button"
                        onClick={() => {
                          handleSwitcherOpenChange(false);
                          openChats();
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition hover:bg-muted"
                      >
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">Chats</span>
                      </button>
                    ) : null}
                    {filteredProjects.map((openProject) => (
                      <button
                        key={openProject.id}
                        type="button"
                        onClick={() => {
                          activateProject(openProject);
                          handleSwitcherOpenChange(false);
                        }}
                        className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition hover:bg-muted"
                      >
                        <span className="w-full truncate text-[13px] text-foreground">
                          {openProject.name}
                        </span>
                        {openProject.workspacePath ? (
                          <span
                            className="w-full truncate text-[10px] text-muted-foreground"
                            title={openProject.workspacePath}
                          >
                            {openProject.workspacePath}
                          </span>
                        ) : null}
                      </button>
                    ))}
                    {filteredProjects.length === 0 && isScratch ? (
                      <div className="px-2 py-2 text-center text-[12px] text-muted-foreground">
                        {openProjects.length === 0
                          ? "No open projects"
                          : "No matches"}
                      </div>
                    ) : null}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
            <section className="flex flex-col gap-3">
              <div className="text-xs uppercase tracking-wider opacity-60">
                Open
              </div>
              <QuickAction
                icon={Plus}
                label="New session"
                onClick={openNewSession}
              />
              <QuickAction
                icon={Search}
                label="Search files…"
                shortcut="⌘K"
                onClick={focusSearchPanel}
              />
              <QuickAction
                icon={BookOpen}
                label="Skills"
                onClick={openSkills}
              />
              <QuickAction
                icon={Images}
                label="Gallery"
                onClick={openGallery}
              />
            </section>

            {recentSessions.length > 0 ? (
              <section className="flex flex-col gap-2">
                <div className="text-xs uppercase tracking-wider opacity-60">
                  Recent
                </div>
                <div className="flex flex-col gap-1">
                  {recentSessions.map((task) => (
                    <RecentSessionItem
                      key={task.id}
                      task={task}
                      onOpen={() => openSession(task)}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </SessionPreviewProvider>
  );
}
