
import { WorkspaceBoardProvider } from "./providers";
import { WorkspaceShell } from "./workspace-shell";

export const KanbanIssueLayout = () => {
  return (
    <WorkspaceBoardProvider>
      <WorkspaceShell />
    </WorkspaceBoardProvider>
  );
};

export default KanbanIssueLayout;
