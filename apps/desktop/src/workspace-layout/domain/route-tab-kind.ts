import type { StoredTask } from "@/session/types";
import type { TabKind } from "../types";

/**
 * Mapping between router locations and tab identities, plus the decision of
 * how a session row opens.
 *
 * The layout store owns which tab is focused; the URL only mirrors it. A row
 * click therefore opens the tab directly and lets the tab → URL sync write the
 * location afterwards. Going the other way (click → navigate → URL watcher →
 * openTab) silently did nothing whenever the target URL was already the
 * current one, which happens as soon as the URL outlives the tab it described:
 * closing a session's last tab leaves an empty pane, and diff/browser tabs
 * carry no path of their own, so neither writes the location back.
 */

/** How a session row opens, given the project its layout is currently bound to. */
export type SessionOpenAction =
  | { type: "tab"; kind: TabKind }
  | { type: "navigate"; taskId: string };

/**
 * Tab identity for a session. Uses the same segment the URL carries so a row
 * click and a deep link resolve to one tab.
 */
export function sessionTabKind(task: StoredTask): TabKind {
  return { type: "session", taskId: task.slug ?? task.id };
}

/**
 * Sessions of the bound project open straight into the layout. Sessions of
 * another project have to route first: the layout store is per project and
 * only rebinds once the project context resolves, so opening a tab now would
 * land it in the outgoing project's layout.
 */
export function resolveSessionOpen(
  task: StoredTask,
  boundProjectId: string | null,
): SessionOpenAction {
  if (boundProjectId && boundProjectId === task.project_id) {
    return { type: "tab", kind: sessionTabKind(task) };
  }
  return { type: "navigate", taskId: task.slug ?? task.id };
}

export function isSameRouteKind(a: TabKind, b: TabKind): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "overview":
      return b.type === "overview";
    case "session":
      return (
        b.type === "session" &&
        a.taskId === b.taskId &&
        (a.runId ?? null) === (b.runId ?? null)
      );
    case "settings":
      return true;
    case "file":
      return (
        b.type === "file" &&
        a.path === b.path &&
        (a.taskRunId ?? null) === (b.taskRunId ?? null)
      );
    case "diff":
      return b.type === "diff" && a.runId === b.runId;
    case "project-diff":
      return b.type === "project-diff" && a.projectId === b.projectId;
    case "browser":
      return b.type === "browser" && a.browserId === b.browserId;
    case "cdp-browser":
      return b.type === "cdp-browser" && a.browserId === b.browserId;
    case "skills":
      return b.type === "skills";
    case "gallery":
      return (
        b.type === "gallery" && (a.taskRunId ?? null) === (b.taskRunId ?? null)
      );
  }
}

export function inferKindFromLocation(pathname: string): TabKind | null {
  if (!projectIdFromPathname(pathname)) return null;
  // /projects/$id (project root) — the project home / overview surface.
  if (/^\/projects\/[^/]+\/?$/.test(pathname)) {
    return { type: "overview" };
  }
  // /projects/$id/session/$taskId/$runId
  const sessionMatch = pathname.match(
    /^\/projects\/[^/]+\/session(?:\/([^/]+))?(?:\/([^/]+))?\/?$/,
  );
  if (sessionMatch?.[1]) {
    return {
      type: "session",
      taskId: decodePathSegment(sessionMatch[1]),
      runId: decodePathSegment(sessionMatch[2]),
    };
  }
  // /projects/$id/session (root) — open a fresh "new session" tab so the
  // chat-start surface renders inside the pane.
  if (sessionMatch) {
    return { type: "session" };
  }
  // /projects/$id/files
  if (pathname.endsWith("/files")) {
    // No specific path — defer to user; do not auto-open
    return null;
  }
  if (pathname.endsWith("/settings")) {
    return { type: "settings" };
  }
  if (pathname.endsWith("/skills")) {
    return { type: "skills" };
  }
  // /projects/$id/gallery — the project-scoped media gallery. Run-scoped
  // galleries are opened imperatively (no URL), like diff tabs.
  if (pathname.endsWith("/gallery")) {
    return { type: "gallery" };
  }
  return null;
}

export function projectIdFromPathname(pathname: string): string | undefined {
  return decodePathSegment(pathname.match(/^\/projects\/([^/]+)/)?.[1]);
}

function decodePathSegment(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function pathFromKind(
  kind: TabKind,
  projectIdParam: string | undefined,
): string | null {
  if (!projectIdParam) return null;
  const base = `/projects/${projectIdParam}`;
  switch (kind.type) {
    case "overview":
      return base;
    case "session":
      if (!kind.taskId) return `${base}/session/`;
      return kind.runId
        ? `${base}/session/${kind.taskId}/${kind.runId}`
        : `${base}/session/${kind.taskId}`;
    case "file":
      return `${base}/files`;
    case "diff":
      return null;
    case "project-diff":
      return null;
    case "browser":
      return null;
    case "cdp-browser":
      return null;
    case "settings":
      return `${base}/settings`;
    case "skills":
      return `${base}/skills`;
    case "gallery":
      // Only the project-scoped gallery owns a URL; run-scoped galleries are
      // imperative tabs (like diff) and do not round-trip through the path.
      return kind.taskRunId ? null : `${base}/gallery`;
  }
}
