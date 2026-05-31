import { createFileRoute } from "@tanstack/react-router";

/**
 * URL-only route. LayoutShell + useRouteTabSync open the settings tab.
 * The SettingsPanel itself is rendered inside the tab body.
 */
export const Route = createFileRoute("/projects/$projectId/settings")({
  component: () => null,
});
