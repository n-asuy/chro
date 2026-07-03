import { taskApi } from "@/tasks/task-api";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/**
 * Open a general-purpose ("scratch") chat: ensure the hidden "General" project
 * and navigate to a fresh session under it. Deliberately does NOT register the
 * project in the open-projects store, so it never appears in the list — its
 * sessions still surface in the cross-project stream. Shared by the projects
 * panel's "New chat" button and the session-search palette's command.
 */
export function useNewChat(): () => Promise<void> {
  const navigate = useNavigate();
  return useCallback(async () => {
    const general = await taskApi.ensureGeneralProject();
    navigate({
      to: "/projects/$projectId/session",
      params: { projectId: general.slug ?? general.id },
    });
  }, [navigate]);
}
