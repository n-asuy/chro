import { useOptionalProjectContext } from "@/files/context/project-context";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  inferKindFromLocation,
  isSameRouteKind,
  pathFromKind,
  projectIdFromPathname,
} from "../domain/route-tab-kind";
import { useLayoutStore } from "../state/layout-store";
import type { PaneLayout, Tab } from "../types";

/**
 * Two-way sync between TanStack Router URL and the layout store's active tab,
 * implementing the C-strategy from `docs/20260419_tab-pane-layout-design.md`.
 *
 * - URL changes (deep link / browser back) → openTab/focus matching kind
 * - Active tab changes (user clicks tab) → navigate the URL to match
 *
 * Layout tree shape is NOT in the URL; only the focused tab's logical
 * resource. Other tabs/panes are layout-store + persistence.
 *
 * This is a mirror, not a command channel: in-app openers (session rows, the
 * search palette) call `openTab` and let the second effect write the URL. A
 * URL that already equals its target produces no location change and so
 * cannot reopen anything — see `domain/route-tab-kind`.
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
