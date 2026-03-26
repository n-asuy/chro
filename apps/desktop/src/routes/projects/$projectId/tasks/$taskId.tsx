import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import KanbanIssueLayout from "@/kanban";

export const Route = createFileRoute("/projects/$projectId/tasks/$taskId")({
  component: ProjectTaskDetailPage,
});

function ProjectTaskDetailPage() {
  const { projectId } = Route.useParams();

  useEffect(() => {
    window.desktop?.setWindowMode?.("session");
  }, []);

  return <KanbanIssueLayout key={projectId} />;
}
