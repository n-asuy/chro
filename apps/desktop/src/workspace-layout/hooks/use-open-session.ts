import type { StoredTask } from "@/session/types";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useAllProjects } from "./use-all-projects";

/**
 * Navigate to a session's route, resolving the project slug when available.
 * Shared by the projects panel (row clicks) and the session-search palette so
 * both open a session exactly the same way.
 */
export function useOpenSession(): (task: StoredTask) => void {
  const navigate = useNavigate();
  const projectsById = useAllProjects(true);
  return useCallback(
    (task: StoredTask) => {
      const projectId = projectsById[task.project_id]?.slug ?? task.project_id;
      navigate({
        to: "/projects/$projectId/session/$taskId",
        params: { projectId, taskId: task.slug ?? task.id },
      });
    },
    [navigate, projectsById],
  );
}
