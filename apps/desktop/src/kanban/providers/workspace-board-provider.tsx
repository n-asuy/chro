/**
 * Provider for workspace board data using WebSocket streaming.
 *
 * Replaces the Zustand store pattern with React Context + WebSocket hooks.
 * Child components use `useWorkspaceBoardContext()` to access board state.
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { useParams } from "@tanstack/react-router";
import {
  useWorkspaceBoard,
  type UseWorkspaceBoardResult,
} from "../hooks/use-workspace-board";
import { taskApi } from "../api/task-api";

interface WorkspaceBoardContextValue extends UseWorkspaceBoardResult {
  workspacePath: string | null;
  projectId: string | null;
}

const WorkspaceBoardContext = createContext<WorkspaceBoardContextValue | null>(
  null,
);

export interface WorkspaceBoardProviderProps {
  children: ReactNode;
}

/**
 * Provider that manages workspace path, project ID resolution, and WebSocket board data.
 *
 * Gets projectId from route params (/projects/:projectId/...) and resolves workspace path.
 *
 * Usage:
 * ```tsx
 * <WorkspaceBoardProvider>
 *   <YourComponent />
 * </WorkspaceBoardProvider>
 * ```
 */
export function WorkspaceBoardProvider({
  children,
}: WorkspaceBoardProviderProps) {
  const params = useParams({ strict: false }) as { projectId?: string };
  const projectId = params.projectId ?? null;
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  // Resolve workspace path from project ID
  useEffect(() => {
    if (!projectId) {
      setWorkspacePath(null);
      setProjectError(null);
      return;
    }

    let cancelled = false;

    const resolveProject = async () => {
      try {
        const project = await taskApi.getProject(projectId);
        if (!cancelled) {
          setWorkspacePath(project.gitRepoPath);
          setProjectError(null);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to resolve project:", error);
          setWorkspacePath(null);
          setProjectError(
            error instanceof Error
              ? error.message
              : "Failed to resolve project",
          );
        }
      }
    };

    void resolveProject();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Get board data from WebSocket hook
  const boardData = useWorkspaceBoard({
    workspacePath,
    projectId,
  });

  // Merge project error with stream error if present
  const error = projectError ?? boardData.error;

  const contextValue: WorkspaceBoardContextValue = {
    ...boardData,
    error,
    workspacePath,
    projectId,
  };

  return (
    <WorkspaceBoardContext.Provider value={contextValue}>
      {children}
    </WorkspaceBoardContext.Provider>
  );
}

/**
 * Hook to access workspace board context.
 *
 * Must be used within a `WorkspaceBoardProvider`.
 *
 * @throws Error if used outside provider
 */
export function useWorkspaceBoardContext(): WorkspaceBoardContextValue {
  const context = useContext(WorkspaceBoardContext);
  if (!context) {
    throw new Error(
      "useWorkspaceBoardContext must be used within a WorkspaceBoardProvider",
    );
  }
  return context;
}

/**
 * Optional version of useWorkspaceBoardContext that returns null
 * when used outside the provider.
 *
 * Use this for components that may be rendered both inside and outside
 * the WorkspaceBoardProvider (e.g., ElectronTitlebar).
 */
export function useOptionalWorkspaceBoardContext(): WorkspaceBoardContextValue | null {
  return useContext(WorkspaceBoardContext);
}
