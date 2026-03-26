import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/session/$taskId/")({
  component: SessionTaskPage,
});

function SessionTaskPage() {
  return null;
}
