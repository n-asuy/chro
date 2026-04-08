/**
 * Thin wrapper that feeds ProjectContext-resolved identifiers into useWorkspaceBoard
 * and exposes the result as React Context for kanban components.
 */

import { createContext, useContext, type ReactNode } from "react";
import { useProjectContext } from "@/files/context/project-context";
import {
  useWorkspaceBoard,
  type UseWorkspaceBoardResult,
} from "../hooks/use-workspace-board";

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

export function WorkspaceBoardProvider({
  children,
}: WorkspaceBoardProviderProps) {
  const { projectId, workspacePath, error: projectError } = useProjectContext();

  const boardData = useWorkspaceBoard({ projectId });

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
 * Must be used within a WorkspaceBoardProvider.
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
 * Optional version that returns null when used outside the provider.
 */
export function useOptionalWorkspaceBoardContext(): WorkspaceBoardContextValue | null {
  return useContext(WorkspaceBoardContext);
}
