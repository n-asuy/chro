import { useOptionalProjectContext } from "@/files/context/project-context";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useLayoutStore } from "../state/layout-store";
import type { PaneLayout, Tab, TabKind } from "../types";

/**
 * Two-way sync between TanStack Router URL and the layout store's active tab,
 * implementing the C-strategy from `docs/20260419_tab-pane-layout-design.md`.
 *
 * - URL changes (deep link / browser back) → openTab/focus matching kind
 * - Active tab changes (user clicks tab) → navigate the URL to match
 *
 * Layout tree shape is NOT in the URL; only the focused tab's logical
 * resource. Other tabs/panes are layout-store + persistence.
 */
export function useRouteTabSync() {
  const params = useParams({ strict: false }) as {
    projectId?: string;
    taskId?: string;
    runId?: string;
  };
  const { projectId } = params;
  const location = useRouterState({ select: (s) => s.location });
  const projectIdFromPath = projectIdFromPathname(location.pathname);
  const currentProjectId = projectIdFromPath ?? projectId;
  const navigate = useNavigate();
  const openTab = useLayoutStore((s) => s.openTab);
  const layout = useLayoutStore((s) => s.layout);
  const boundProjectId = useLayoutStore((s) => s.projectId);
  const projectContext = useOptionalProjectContext();
  const skipActiveSyncPathRef = useRef<string | null>(null);

  // During a project switch the URL changes synchronously but the layout
  // store rebinds later (after the project context resolves and
  // LayoutShell calls `bindProject`). While these are out of sync, any
  // openTab call would land on the *previous* project's layout, and any
  // Active→URL nav would write the previous project's tab into the new
  // URL. Detect alignment and gate both effects on it.
  const inSync =
    projectContext?.projectId != null &&
    projectContext.projectId === boundProjectId &&
    projectIdFromPath != null &&
    (projectIdFromPath === projectContext.projectSlug ||
      projectIdFromPath === projectContext.projectId);

  // URL → openTab
  useEffect(() => {
    if (!inSync) return;
    const kind = inferKindFromLocation(location.pathname);
    if (!kind) return;
    const store = useLayoutStore.getState();
    const focused = findFocusedTab(store.layout);
    if (focused && isSameRouteKind(focused.kind, kind)) return;

    // When the URL transitions from `/session/` to `/session/{taskId}` because
    // the user just submitted their first prompt in a "new session" tab, the
    // focused tab is a session-without-taskId. Upgrade its kind in place so
    // we keep the same tab instance instead of opening a second session tab
    // alongside it.
    if (kind.type === "session" && kind.taskId) {
      if (focused?.kind.type === "session" && !focused.kind.taskId) {
        skipActiveSyncPathRef.current = location.pathname;
        store.setTabKind(focused.id, kind);
        return;
      }
    }

    skipActiveSyncPathRef.current = location.pathname;
    openTab(kind, { activate: true });
  }, [location.pathname, openTab, inSync]);

  // Active tab → URL
  useEffect(() => {
    if (!inSync) return;
    const tab = findFocusedTab(layout);
    if (!tab) return;
    if (skipActiveSyncPathRef.current === location.pathname) {
      skipActiveSyncPathRef.current = null;
      return;
    }
    // If the URL no longer points at a project (e.g. the user just navigated
    // to /workspace), don't yank them back. `useParams` can still expose the
    // previous projectId here during the transition, so trust the path.
    if (!projectIdFromPath) return;
    const target = pathFromKind(tab.kind, currentProjectId);
    if (target && target !== location.pathname) {
      void navigate({ to: target, replace: false });
    }
  }, [
    layout,
    navigate,
    location.pathname,
    currentProjectId,
    projectIdFromPath,
    inSync,
  ]);
}

export function findFocusedTab(layout: PaneLayout): Tab | null {
  const stack = [layout.root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "leaf") {
      if (node.id === layout.focusedPaneId) {
        return node.tabs.find((t) => t.id === node.activeTabId) ?? null;
      }
    } else {
      stack.push(node.children[0], node.children[1]);
    }
  }
  return null;
}

function isSameRouteKind(a: TabKind, b: TabKind): boolean {
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
      return (
        b.type === "diff" &&
        a.runId === b.runId &&
        (a.path ?? null) === (b.path ?? null)
      );
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

function projectIdFromPathname(pathname: string): string | undefined {
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
