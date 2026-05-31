import { useProjectTasks } from "@/session/context/project-tasks-context";
import { useEffect } from "react";
import { useLayoutStore } from "../state/layout-store";
import type { PaneNode, Tab } from "../types";

/**
 * Keep session tab titles in sync with the user-entered task title (the same
 * label shown in the sessions sidebar). Subscribes once at the LayoutShell
 * level so all panes share a single tasks stream.
 *
 * Looks up each session tab's `kind.taskId` (which may be either the slug or
 * the UUID, per the route param convention) and patches `tab.title` to the
 * task's `title` whenever it changes.
 */
export function useSessionTabTitleSync() {
  const { taskByKey } = useProjectTasks();
  const layout = useLayoutStore((s) => s.layout);
  const patchTab = useLayoutStore((s) => s.patchTab);

  useEffect(() => {
    for (const tab of collectSessionTabs(layout.root)) {
      const taskId = tab.kind.type === "session" ? tab.kind.taskId : null;
      if (!taskId) continue;
      const task = taskByKey.get(taskId);
      const desired = task?.title?.trim();
      if (!desired || desired === tab.title) continue;
      patchTab(tab.id, { title: desired });
    }
  }, [layout, taskByKey, patchTab]);
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
