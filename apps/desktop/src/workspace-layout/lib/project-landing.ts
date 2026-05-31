import { findFocusedTab, pathFromKind } from "../hooks/use-route-tab-sync";
import { loadLayout } from "./persistence";

/**
 * Resolve the URL to land on when switching to a project. Falls back to
 * the project's `/session` landing when there's no persisted layout (or
 * no focused tab), so the URL → openTab sync naturally opens a fresh
 * session. When a layout exists, navigate directly at its focused tab to
 * avoid clobbering it with a "new session" entry on every switch.
 */
export function resolveProjectLandingPath(
  projectUuid: string,
  projectSlug: string,
): string {
  const persisted = loadLayout(projectUuid);
  const focused = persisted ? findFocusedTab(persisted) : null;
  if (focused) {
    const path = pathFromKind(focused.kind, projectSlug);
    if (path) return path;
  }
  return `/projects/${encodeURIComponent(projectSlug)}/session/`;
}
