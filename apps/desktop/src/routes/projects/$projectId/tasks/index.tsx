import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import KanbanIssueLayout from "@/kanban";

export const Route = createFileRoute("/projects/$projectId/tasks/")({
  component: ProjectTasksPage,
});

function ProjectTasksPage() {
  const { projectId } = Route.useParams();
  useDocumentTitle("Tasks");

  useEffect(() => {
    window.desktop?.setWindowMode?.("session");
  }, []);

  return <KanbanIssueLayout key={projectId} />;
}
