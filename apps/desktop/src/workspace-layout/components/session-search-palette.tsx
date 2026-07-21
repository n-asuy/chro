import { useLanguage } from "@/i18n";
import { applyPendingSubmissionGroupsToTasks } from "@/session/domain/session-task-state";
import { useArchivedSessions, useInboxTasksStream } from "@/session/hooks";
import { useAllPendingSessionSubmissions } from "@/session/state/pending-session-submissions-store";
import { useSessionReadStore } from "@/session/state/session-read-store";
import { useCallback, useMemo } from "react";
import { useAllProjects } from "../hooks/use-all-projects";
import { useNewChat } from "../hooks/use-new-chat";
import { useOpenSession } from "../hooks/use-open-session";
import { useProjectNavigation } from "../hooks/use-project-navigation";
import { useCommandPaletteStore } from "../state/command-palette-store";
import { useOpenProjectsStore } from "../state/open-projects-store";
import { CommandPalette } from "./command-palette";

/**
 * Always-mounted host for the quick-switcher palette (⌘K / ⌘P). Kept out of
 * the left dock — which unmounts when collapsed — so the global shortcut can
 * open the modal regardless of dock state, and opening it never nudges the
 * layout. Owns the palette's data: every non-archived session across projects
 * (most-recent-first) plus the project list, so any destination is reachable
 * from the box. Open state lives in {@link useCommandPaletteStore}, which the
 * projects panel's Search button also drives.
 */
export function SessionSearchPalette() {
  const { t } = useLanguage();

  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  // Only subscribe while the palette is open. When the left dock is expanded its
  // sidebar already holds a warm inbox subscription, so the shared-WS registry
  // hands this consumer the current snapshot the instant it opens; when nothing
  // else subscribes it's one cheap round-trip rather than a permanent stream.
  const { tasks: streamTasks } = useInboxTasksStream(open);
  const pendingGroups = useAllPendingSessionSubmissions();
  const { isArchived } = useArchivedSessions();
  const projectsById = useAllProjects(true);
  const openProjects = useOpenProjectsStore((s) => s.projects);
  const viewedAt = useSessionReadStore((s) => s.viewedAt);

  const sessions = useMemo(() => {
    const merged = applyPendingSubmissionGroupsToTasks(
      streamTasks,
      pendingGroups,
    );
    return merged
      .filter((task) => !isArchived(task))
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
  }, [streamTasks, pendingGroups, isArchived]);

  // Project destinations: everything but the hidden General project, which is
  // reachable through "New chat" instead of by name.
  const projects = useMemo(
    () =>
      Object.values(projectsById)
        .filter((project) => !project.isGeneral)
        .map((project) => ({ id: project.id, name: project.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projectsById],
  );

  const resolveProjectName = useCallback(
    (id: string) =>
      projectsById[id]?.name ??
      openProjects.find((project) => project.id === id)?.name ??
      null,
    [projectsById, openProjects],
  );

  const lastViewedAt = useCallback(
    (taskId: string) => viewedAt[taskId],
    [viewedAt],
  );

  const onNewChat = useNewChat();
  const onOpenSession = useOpenSession();

  const { activateProject } = useProjectNavigation();
  const onOpenProject = useCallback(
    (projectId: string) => {
      const project = projectsById[projectId];
      if (!project) return;
      activateProject({
        id: project.id,
        slug: project.slug ?? null,
        name: project.name,
        workspacePath: project.gitRepoPath ?? null,
      });
    },
    [projectsById, activateProject],
  );

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      sessions={sessions}
      projects={projects}
      projectName={resolveProjectName}
      lastViewedAt={lastViewedAt}
      onNewChat={onNewChat}
      onOpenSession={onOpenSession}
      onOpenProject={onOpenProject}
      t={t}
    />
  );
}
