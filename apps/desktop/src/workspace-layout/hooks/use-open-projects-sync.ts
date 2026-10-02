import { useOptionalProjectContext } from "@/files/context/project-context";
import type { ProjectResponse } from "@/tasks/task-api";
import { useEffect } from "react";
import { useOpenProjectsStore } from "../state/open-projects-store";

/**
 * Reflect the project resolved from the URL into the open-projects store.
 * Repositories are registered as open; the hidden scratch ("General") project
 * never is, because its sessions belong under Chats rather than Projects. A
 * scratch entry persisted by an earlier build is evicted on the way through.
 */
export function syncRouteProject(project: ProjectResponse): void {
  const store = useOpenProjectsStore.getState();
  if (project.isGeneral) {
    store.closeProject(project.id);
    return;
  }
  store.openProject({
    id: project.id,
    slug: project.slug ?? null,
    name: project.name,
    workspacePath: project.gitRepoPath ?? null,
  });
}

/**
 * Keeps the open-projects store in sync with persistence and the current
 * route. Mounted once high in the layout shell (not inside the dock panel)
 * so it runs even when the left dock is collapsed.
 *
 * 1. Hydrate from persisted UI state. `loadUiState()` resolves async, so the
 *    first attempt usually sees an empty cache — poll every 50ms until it
 *    succeeds (the store returns true once `isUiStateReady()`).
 * 2. Whenever the current project resolves from the URL, sync it into the
 *    store (see `syncRouteProject`). Covers direct URL navigation and the
 *    first-render case where storage hadn't yet hydrated.
 */
export function useOpenProjectsSync(): void {
  const projectContext = useOptionalProjectContext();
  const hydrate = useOpenProjectsStore((s) => s.hydrate);
  const hydrated = useOpenProjectsStore((s) => s.hydrated);

  useEffect(() => {
    if (hydrate()) return;
    const id = window.setInterval(() => {
      if (hydrate()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [hydrate]);

  // Re-run once hydrated so a persisted scratch entry is evicted even when the
  // route resolved before storage loaded.
  useEffect(() => {
    const project = projectContext?.project;
    if (project) syncRouteProject(project);
  }, [projectContext?.project, hydrated]);
}
