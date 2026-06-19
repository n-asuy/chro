import { createFileRoute } from "@tanstack/react-router";

/**
 * URL-only route. LayoutShell + useRouteTabSync open the gallery tab.
 * The GalleryPanel itself is rendered inside the tab body.
 */
export const Route = createFileRoute("/projects/$projectId/gallery")({
  component: () => null,
});
