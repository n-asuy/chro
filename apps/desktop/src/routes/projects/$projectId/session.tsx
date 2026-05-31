import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Layout-only route. The visual surface is owned by `LayoutShell` mounted
 * at the parent `/projects/$projectId` route; this route exists so nested
 * `/session/$taskId/$runId` URLs can match and the URL ↔ tab sync hook can
 * read their params via `useParams({ strict: false })`.
 */
export const Route = createFileRoute("/projects/$projectId/session")({
  component: () => <Outlet />,
});
