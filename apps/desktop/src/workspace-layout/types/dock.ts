/**
 * Dock panels. A dock is a single-slot container: at any moment one panel
 * is rendered. Switching panels preserves each panel's local state (scroll
 * position, expanded folders, query text) — implementations keep their own
 * zustand stores; the dock only tracks which is active.
 *
 * The left dock hosts only the projects panel (the project tree with its
 * chats nested underneath); everything else (file tree, search, source
 * control) lives in the right dock.
 */

export type LeftDockPanelKind = "projects";

/**
 * `agent` is the standing agent of one directory: its brief file, the ledger
 * of finished sessions addressed to it, and the entry point for a new session
 * scoped to it. Its subject is {@link DirectoryAgentTarget}.
 */
export type RightDockPanelKind =
  | "filetree"
  | "search"
  | "source-control"
  | "agent";

export type DockPanelKind = LeftDockPanelKind | RightDockPanelKind;

/** A directory of a project's main checkout, repo-relative (`""` is the root). */
export interface DirectoryAgentTarget {
  projectId: string;
  path: string;
}

export interface DockState {
  /** Active panel; null collapses the dock to icon-only chrome */
  activePanel: DockPanelKind | null;
  /** Width of the dock content area in pixels */
  width: number;
  /** True hides everything except the bottom action bar */
  collapsed: boolean;
}

export const DEFAULT_DOCK_WIDTH = 280;
export const MIN_DOCK_WIDTH = 200;
export const MAX_DOCK_WIDTH = 600;
