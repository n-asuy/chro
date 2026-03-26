import { createFileRoute } from "@tanstack/react-router";
import { SessionShell } from "@/session";

export const Route = createFileRoute("/projects/$projectId/session")({
  component: SessionLayoutPage,
});

function SessionLayoutPage() {
  return <SessionShell />;
}
