import { slugOrId } from "@/lib/slug";
import { touchRecentWorkspace } from "@/lib/workspace-history";
import type { StoredTask } from "@/session/types";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { resolveProjectLandingPath } from "../lib/project-landing";
import { useLayoutStore } from "../state/layout-store";
import type { OpenProjectTab } from "../state/open-projects-store";

export interface ProjectNavigation {
  /**
   * Switch to a project, landing on its persisted focused tab (or a fresh
   * `/session` when it has no saved layout yet).
   */
  activateProject: (project: OpenProjectTab) => void;
  /** Open a specific chat (task) within a project, optionally at a run. */
  openSession: (
    project: OpenProjectTab,
    task: StoredTask,
    runId?: string,
  ) => void;
  /** Start a fresh chat in a project. */
  newSession: (project: OpenProjectTab) => void;
}

/**
 * Navigation helpers for the left-dock project tree. All navigation is
 * URL-driven — `ProjectProvider` re-resolves the active project from the
 * route, which in turn rebinds the layout/dock stores. Switching to another
 * project's chat therefore needs nothing beyond navigating to its URL.
 */
export function useProjectNavigation(): ProjectNavigation {
  const navigate = useNavigate();
  const openTab = useLayoutStore((state) => state.openTab);

  const activateProject = useCallback(
    (project: OpenProjectTab) => {
      const slug = project.slug ?? project.id;
      navigate({ to: resolveProjectLandingPath(project.id, slug) });
      if (project.workspacePath) {
        touchRecentWorkspace(project.workspacePath, {
          projectId: project.id,
          projectSlug: project.slug,
          projectName: project.name,
        });
      }
    },
    [navigate],
  );

  const openSession = useCallback(
    (project: OpenProjectTab, task: StoredTask, runId?: string) => {
      const projectId = project.slug ?? project.id;
      const taskId = slugOrId(task);
      if (runId) {
        navigate({
          to: "/projects/$projectId/session/$taskId/$runId",
          params: { projectId, taskId, runId },
        });
        return;
      }
      navigate({
        to: "/projects/$projectId/session/$taskId",
        params: { projectId, taskId },
      });
    },
    [navigate],
  );

  const newSession = useCallback(
    (project: OpenProjectTab) => {
      const projectId = project.slug ?? project.id;
      const boundProjectId = useLayoutStore.getState().projectId;
      if (boundProjectId === project.id) {
        openTab({ type: "session" }, { activate: true });
      }
      navigate({ to: "/projects/$projectId/session", params: { projectId } });
    },
    [navigate, openTab],
  );

  return { activateProject, openSession, newSession };
}
