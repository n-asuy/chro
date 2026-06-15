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
import type { StoredTask } from "@/session/types";
import { useNavigate } from "@tanstack/react-router";
import { BookOpen, Plus, Search } from "lucide-react";
import { useMemo } from "react";
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
  const { project, projectSlug } = useProjectContext();
  const navigate = useNavigate();
  const focusSearchPanel = useRightDockStore((s) => s.focusSearchPanel);
  const projectTasks = useOptionalProjectTasks();
  const { isArchived } = useArchivedSessions();

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
            {projectName ? (
              <div className="flex items-center gap-2">
                <FolderSolidIcon className="h-4 w-4 shrink-0 opacity-70" />
                <h1 className="min-w-0 truncate text-base font-medium">
                  {projectName}
                </h1>
              </div>
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
