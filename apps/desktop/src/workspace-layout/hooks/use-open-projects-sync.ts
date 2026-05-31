import { useOptionalProjectContext } from "@/files/context/project-context";
import { useEffect } from "react";
import { useOpenProjectsStore } from "../state/open-projects-store";

/**
 * Keeps the open-projects store in sync with persistence and the current
 * route. Mounted once high in the layout shell (not inside the dock panel)
 * so it runs even when the left dock is collapsed.
 *
 * 1. Hydrate from persisted UI state. `loadUiState()` resolves async, so the
 *    first attempt usually sees an empty cache — poll every 50ms until it
 *    succeeds (the store returns true once `isUiStateReady()`).
 * 2. Whenever the current project resolves from the URL, ensure it's present
 *    in the store. Covers direct URL navigation and the first-render case
 *    where storage hadn't yet hydrated.
 */
export function useOpenProjectsSync(): void {
  const projectContext = useOptionalProjectContext();
  const hydrate = useOpenProjectsStore((s) => s.hydrate);
  const openProject = useOpenProjectsStore((s) => s.openProject);

  useEffect(() => {
    if (hydrate()) return;
    const id = window.setInterval(() => {
      if (hydrate()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [hydrate]);

  useEffect(() => {
    const project = projectContext?.project;
    if (!project) return;
    openProject({
      id: project.id,
      slug: project.slug ?? null,
      name: project.name,
      workspacePath: project.gitRepoPath ?? null,
    });
  }, [projectContext?.project, openProject]);
}
