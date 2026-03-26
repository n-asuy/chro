import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/projects/$projectId/session/$taskId/$runId"
)({
  component: SessionRunPage,
});

function SessionRunPage() {
  return null;
}
