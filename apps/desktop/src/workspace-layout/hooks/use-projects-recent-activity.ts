import { taskApi } from "@/tasks/task-api";
import { useQueries } from "@tanstack/react-query";
import type { OpenProjectTab } from "../state/open-projects-store";

/**
 * Latest completed-task timestamp (epoch ms) per project, used to order the
 * projects panel by "most recent task completion". Fetches each open project's
 * tasks via REST and keeps the result cached; only runs while `enabled` so the
 * fan-out happens exclusively when the recency sort mode is active.
 *
 * Projects without a workspace path, or with no completed task yet, map to 0 so
 * they sort to the bottom.
 */
export function useProjectsRecentActivity(
  projects: OpenProjectTab[],
  enabled: boolean,
): Record<string, number> {
  const results = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["project-recent-activity", project.id, project.workspacePath],
      queryFn: async (): Promise<number> => {
        if (!project.workspacePath) return 0;
        const tasks = await taskApi.list(project.workspacePath);
        let latest = 0;
        for (const task of tasks) {
          if (task.status !== "completed") continue;
          const completedAt = new Date(task.updated_at).getTime();
          if (completedAt > latest) latest = completedAt;
        }
        return latest;
      },
      enabled: enabled && Boolean(project.workspacePath),
      staleTime: 30_000,
    })),
  });

  const activityById: Record<string, number> = {};
  projects.forEach((project, index) => {
    activityById[project.id] = results[index]?.data ?? 0;
  });
  return activityById;
}
