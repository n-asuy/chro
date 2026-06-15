import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/")({
  component: ProjectOverviewPage,
});

// No-op shell: the overview surface is rendered by LayoutShell's pane registry
// (driven by the URL via route-tab-sync), mirroring the session index route.
function ProjectOverviewPage() {
  return null;
}
