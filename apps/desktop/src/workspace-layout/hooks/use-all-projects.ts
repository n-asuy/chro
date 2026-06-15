import { type ProjectResponse, taskApi } from "@/tasks/task-api";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * All projects known to the backend, keyed by id. Backs the cross-project
 * inbox, which resolves each task's `project_id` to a name/slug without
 * requiring the project to be open in the sidebar.
 *
 * Only fetched while `enabled` (the inbox view is active) and cached for a
 * minute, since the project set changes rarely relative to task activity.
 */
export function useAllProjects(
  enabled: boolean,
): Record<string, ProjectResponse> {
  const { data } = useQuery({
    queryKey: ["all-projects"],
    queryFn: () => taskApi.listProjects(),
    enabled,
    staleTime: 60_000,
  });

  return useMemo(() => {
    const byId: Record<string, ProjectResponse> = {};
    for (const project of data ?? []) byId[project.id] = project;
    return byId;
  }, [data]);
}
