import { type ProjectResponse, taskApi } from "@/tasks/task-api";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

export const ALL_PROJECTS_QUERY_KEY = ["all-projects"] as const;

/**
 * Upsert a project the client just learned about (e.g. one it created) into the
 * cached list, so views keyed on that list see it immediately instead of after
 * the next refetch. An unfetched list is left alone: its first fetch covers it.
 */
export function rememberProject(
  queryClient: QueryClient,
  project: ProjectResponse,
): void {
  queryClient.setQueryData<ProjectResponse[]>(
    ALL_PROJECTS_QUERY_KEY,
    (projects) => {
      if (!projects) return projects;
      const index = projects.findIndex((p) => p.id === project.id);
      if (index < 0) return [...projects, project];
      const next = projects.slice();
      next[index] = project;
      return next;
    },
  );
}

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
    queryKey: ALL_PROJECTS_QUERY_KEY,
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

/**
 * Persist a project's badge color (or null for auto). Applies the change to
 * the cached project list optimistically so every dot repaints immediately,
 * then reconciles with the server response.
 */
export function useSetProjectBadgeColor(): (
  projectId: string,
  badgeColor: string | null,
) => void {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({
      projectId,
      badgeColor,
    }: {
      projectId: string;
      badgeColor: string | null;
    }) => taskApi.setProjectBadgeColor(projectId, badgeColor),
    onMutate: async ({ projectId, badgeColor }) => {
      await queryClient.cancelQueries({ queryKey: ALL_PROJECTS_QUERY_KEY });
      queryClient.setQueryData<ProjectResponse[]>(
        ALL_PROJECTS_QUERY_KEY,
        (projects) =>
          projects?.map((project) =>
            project.id === projectId ? { ...project, badgeColor } : project,
          ),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ALL_PROJECTS_QUERY_KEY });
    },
  });
  return (projectId, badgeColor) => mutation.mutate({ projectId, badgeColor });
}
