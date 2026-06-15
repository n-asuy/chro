import { slugOrId } from "@/lib/slug";
import { touchRecentWorkspace } from "@/lib/workspace-history";
import { taskApi } from "@/tasks/task-api";
import { resolveProjectLandingPath } from "@/workspace-layout/lib/project-landing";
import { useOpenProjectsStore } from "@/workspace-layout/state/open-projects-store";

/**
 * Resolve a workspace folder into an open project and return the route to land
 * on. Centralizes the "ensure project → remember it → register as an open tab →
 * compute landing path" flow that used to live in the standalone `/workspace`
 * page and the project switcher dropdown.
 *
 * Side effects (project creation, recent-workspace history, open-projects
 * store) are performed here; navigation is left to the caller so it can use its
 * own correctly-typed router instance.
 */
export async function prepareWorkspace(path: string): Promise<string> {
  const project = await taskApi.ensureProject(path);

  touchRecentWorkspace(path, {
    projectId: project.id,
    projectSlug: project.slug,
    projectName: project.name,
  });

  useOpenProjectsStore.getState().openProject({
    id: project.id,
    slug: project.slug ?? null,
    name: project.name,
    workspacePath: project.gitRepoPath ?? path,
  });

  // Land on the project overview (home) — a minimal surface listing recent
  // sessions — rather than restoring the last open tab. Persisted tabs stay
  // in the tab bar; the overview is focused on top.
  return resolveProjectLandingPath(project.id, slugOrId(project));
}
