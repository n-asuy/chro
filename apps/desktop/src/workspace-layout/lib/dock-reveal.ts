/** The dock-store fields that decide whether a store update asks to show it. */
export interface DockRevealView {
  projectId: string | null;
  hydrated: boolean;
  width: number;
  collapsed: boolean;
  activePanel: string | null;
}

/**
 * Whether a dock-store update is someone asking to see the dock: the dock
 * ends up open and the update was an open/select/focus action rather than a
 * resize or (re)hydration. Re-selecting the panel that is already open counts,
 * because it is still a request to look at it. A maximized pane uses this to
 * step aside instead of swallowing the request.
 */
export function isDockRevealRequest(
  prev: DockRevealView,
  next: DockRevealView,
): boolean {
  if (prev === next) return false;
  if (next.collapsed || next.activePanel === null) return false;
  return (
    prev.width === next.width &&
    prev.hydrated === next.hydrated &&
    prev.projectId === next.projectId
  );
}
