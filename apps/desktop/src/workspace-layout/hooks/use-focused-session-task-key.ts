import { useLayoutStore } from "../state/layout-store";

/**
 * Raw focused-session task identifier (slug or id) for the bound layout, or
 * null when the focused tab isn't a session.
 */
export function useFocusedSessionTaskKey(): string | null {
  const layout = useLayoutStore((s) => s.layout);
  const focused = layout.focusedPaneId;
  const stack = [layout.root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "leaf") {
      if (node.id !== focused) continue;
      const tab = node.tabs.find((entry) => entry.id === node.activeTabId);
      if (tab && tab.kind.type === "session") {
        return tab.kind.taskId ?? null;
      }
      return null;
    }
    stack.push(node.children[0], node.children[1]);
  }
  return null;
}
