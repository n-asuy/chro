import { createFileRoute } from "@tanstack/react-router";

/**
 * URL-only route. LayoutShell + useRouteTabSync open the skills tab.
 * The SkillsPanel itself is rendered inside the tab body.
 */
export const Route = createFileRoute("/projects/$projectId/skills")({
  component: () => null,
});
