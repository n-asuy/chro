import type { StoredTask } from "@/session/types";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { resolveSessionOpen } from "../domain/route-tab-kind";
import { useLayoutStore } from "../state/layout-store";
import { useAllProjects } from "./use-all-projects";

/**
 * Open a session in the layout, resolving the project slug when a route is
 * needed. Shared by the projects panel (row clicks) and the session-search
 * palette so both open a session exactly the same way.
 *
 * Sessions of the current project open as a tab and the URL follows; only a
 * cross-project open routes, because the layout store has to rebind first.
 */
export function useOpenSession(): (task: StoredTask) => void {
  const navigate = useNavigate();
  const projectsById = useAllProjects(true);
  return useCallback(
    (task: StoredTask) => {
      const store = useLayoutStore.getState();
      const action = resolveSessionOpen(task, store.projectId);
      if (action.type === "tab") {
        store.openTab(action.kind, { activate: true });
        return;
      }
      const projectId = projectsById[task.project_id]?.slug ?? task.project_id;
      navigate({
        to: "/projects/$projectId/session/$taskId",
        params: { projectId, taskId: action.taskId },
      });
    },
    [navigate, projectsById],
  );
}
