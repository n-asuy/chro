import { taskApi } from "@/tasks/task-api";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { rememberProject } from "./use-all-projects";

/**
 * Open a general-purpose ("scratch") chat: ensure the hidden "General" project
 * and navigate to a fresh session under it. The project is never registered in
 * the open-projects store; instead it is recorded in the all-projects cache so
 * the sidebar recognizes it as scratch and files its sessions under Chats even
 * when the cached list predates the project's creation.
 */
export function useNewChat(): () => Promise<void> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    const general = await taskApi.ensureGeneralProject();
    rememberProject(queryClient, general);
    navigate({
      to: "/projects/$projectId/session",
      params: { projectId: general.slug ?? general.id },
    });
  }, [navigate, queryClient]);
}
