import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useParams } from "@tanstack/react-router";
import { taskApi, type ProjectResponse } from "@/kanban/api/task-api";

interface ProjectContextValue {
  /** Resolved UUID — use this for all API calls */
  projectId: string | null;
  /** Short slug from URL — use this for navigation */
  projectSlug: string | null;
  project: ProjectResponse | null;
  workspacePath: string | null;
  isLoading: boolean;
  error: string | null;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const params = useParams({ strict: false }) as { projectId?: string };
  // Route param may be a slug or UUID (backward compat)
  const routeIdentifier = params.projectId ?? null;
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!routeIdentifier) {
      setProject(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    taskApi
      .getProject(routeIdentifier)
      .then((proj) => {
        if (!cancelled) {
          setProject(proj);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[project-context] Failed to load project:", err);
          setError(
            err instanceof Error ? err.message : "Failed to load project",
          );
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [routeIdentifier]);

  const value: ProjectContextValue = {
    projectId: project?.id ?? null,
    projectSlug: project?.slug ?? routeIdentifier,
    project,
    workspacePath: project?.gitRepoPath ?? null,
    isLoading,
    error,
  };

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProjectContext(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProjectContext must be used within a ProjectProvider");
  }
  return context;
}

export function useProjectId(): string | null {
  const { projectId } = useProjectContext();
  return projectId;
}

/**
 * Optional version of useProjectContext that returns null
 * if no ProjectProvider is present. Useful for components like
 * ElectronTitlebar that may render outside the provider.
 */
export function useOptionalProjectContext(): ProjectContextValue | null {
  return useContext(ProjectContext);
}
