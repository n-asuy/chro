import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/session/")({
  component: SessionPage,
});

function SessionPage() {
  return null;
}
