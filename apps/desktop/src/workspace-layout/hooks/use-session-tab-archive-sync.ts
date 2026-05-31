import { useProjectContext } from "@/files/context/project-context";
import { useArchivedSessions, useProjectTasksStream } from "@/session/hooks";
import type { StoredTask } from "@/session/types";
import { useEffect, useMemo } from "react";
import { useLayoutStore } from "../state/layout-store";
import type { PaneNode, Tab } from "../types";

/**
 * Close session tabs whose underlying task has been archived. Mirrors the
 * sidebar list, which hides archived tasks — once a session is archived the
 * tab no longer points at a reachable resource, so it should disappear too.
 *
 * Reactive on the project tasks stream so it covers every archive entry point
 * (sidebar, API), not just the sidebar handler.
 */
export function useSessionTabArchiveSync() {
  const { projectId } = useProjectContext();
  const { tasks } = useProjectTasksStream({
    projectId,
    enabled: Boolean(projectId),
  });
  const { isArchived } = useArchivedSessions();
  const layout = useLayoutStore((s) => s.layout);
  const closeTab = useLayoutStore((s) => s.closeTab);

  const archivedTaskKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const task of tasks) {
      if (!isArchived(task)) continue;
      keys.add(task.id);
      if (task.slug) keys.add(task.slug);
    }
    return keys;
  }, [tasks, isArchived]);

  useEffect(() => {
    if (archivedTaskKeys.size === 0) return;
    const tabIdsToClose: string[] = [];
    for (const tab of collectSessionTabs(layout.root)) {
      const taskId = tab.kind.type === "session" ? tab.kind.taskId : null;
      if (!taskId) continue;
      if (archivedTaskKeys.has(taskId)) tabIdsToClose.push(tab.id);
    }
    for (const tabId of tabIdsToClose) closeTab(tabId);
  }, [layout, archivedTaskKeys, closeTab]);
}

function* collectSessionTabs(node: PaneNode): Generator<Tab> {
  if (node.type === "leaf") {
    for (const tab of node.tabs) {
      if (tab.kind.type === "session") yield tab;
    }
    return;
  }
  for (const child of node.children) {
    yield* collectSessionTabs(child);
  }
}
