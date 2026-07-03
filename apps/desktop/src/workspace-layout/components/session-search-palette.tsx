import { useLanguage } from "@/i18n";
import { applyPendingSubmissionGroupsToTasks } from "@/session/domain/session-task-state";
import { useArchivedSessions, useInboxTasksStream } from "@/session/hooks";
import { useAllPendingSessionSubmissions } from "@/session/state/pending-session-submissions-store";
import { useCallback, useMemo } from "react";
import { useAllProjects } from "../hooks/use-all-projects";
import { useNewChat } from "../hooks/use-new-chat";
import { useOpenSession } from "../hooks/use-open-session";
import { useCommandPaletteStore } from "../state/command-palette-store";
import { useOpenProjectsStore } from "../state/open-projects-store";
import { CommandPalette } from "./command-palette";

/**
 * Always-mounted host for the session-search command palette (⌘K / ⌘P). Kept
 * out of the left dock — which unmounts when collapsed — so the global shortcut
 * can open the modal regardless of dock state, and opening it never nudges the
 * layout. Owns the palette's data: every non-archived session across projects,
 * most-recent-first, so any session is reachable from the search box (not just
 * the open-project inbox). Open state lives in {@link useCommandPaletteStore},
 * which the projects panel's Search button also drives.
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

  const resolveProjectName = useCallback(
    (id: string) =>
      projectsById[id]?.name ??
      openProjects.find((project) => project.id === id)?.name ??
      null,
    [projectsById, openProjects],
  );

  const onNewChat = useNewChat();
  const onOpenSession = useOpenSession();

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      sessions={sessions}
      projectName={resolveProjectName}
      onNewChat={onNewChat}
      onOpenSession={onOpenSession}
      t={t}
    />
  );
}
