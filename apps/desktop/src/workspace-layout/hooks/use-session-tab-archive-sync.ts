import { useProjectContext } from "@/files/context/project-context";
import { useArchivedSessions, useProjectTasksStream } from "@/session/hooks";
import type { StoredTask } from "@/session/types";
import { useEffect, useRef } from "react";
import { useLayoutStore } from "../state/layout-store";
import type { PaneNode, Tab } from "../types";

/** Archive state of each streamed task as last observed, keyed by task id. */
export type ArchiveObservation = ReadonlyMap<string, boolean>;

/**
 * Diff the stream against the previous observation and return the tab keys
 * (id and slug) of tasks that went from live to archived. A task first seen
 * already archived is not a transition: it was opened on purpose, e.g. from a
 * directory's history, and closing its tab would bounce focus back to
 * whatever was open before.
 */
export function observeArchiveTransitions(
  previous: ArchiveObservation,
  tasks: readonly StoredTask[],
  isArchived: (task: StoredTask) => boolean,
): { observed: ArchiveObservation; newlyArchivedKeys: Set<string> } {
  const observed = new Map<string, boolean>();
  const newlyArchivedKeys = new Set<string>();
  for (const task of tasks) {
    const archived = isArchived(task);
    observed.set(task.id, archived);
    if (archived && previous.get(task.id) === false) {
      newlyArchivedKeys.add(task.id);
      if (task.slug) newlyArchivedKeys.add(task.slug);
    }
  }
  return { observed, newlyArchivedKeys };
}

/**
 * Close session tabs whose underlying task gets archived. Mirrors the
 * sidebar list, which hides archived tasks: archiving a session dismisses it
 * everywhere. Viewing an already-archived session stays possible.
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
  const observationRef = useRef<ArchiveObservation>(new Map());

  useEffect(() => {
    const { observed, newlyArchivedKeys } = observeArchiveTransitions(
      observationRef.current,
      tasks,
      isArchived,
    );
    observationRef.current = observed;
    if (newlyArchivedKeys.size === 0) return;
    const { layout, closeTab } = useLayoutStore.getState();
    const tabIdsToClose: string[] = [];
    for (const tab of collectSessionTabs(layout.root)) {
      const taskId = tab.kind.type === "session" ? tab.kind.taskId : null;
      if (!taskId) continue;
      if (newlyArchivedKeys.has(taskId)) tabIdsToClose.push(tab.id);
    }
    for (const tabId of tabIdsToClose) closeTab(tabId);
  }, [tasks, isArchived]);
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
