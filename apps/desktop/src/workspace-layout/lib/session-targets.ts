import type { PaneNode, Tab } from "../types";
import { allLeaves } from "./pane-tree";

/** A session tab that can receive content into its composer. */
export type SessionTarget = {
  tabId: string;
  leafId: string;
  title: string;
};

/** Composer scope id of a session rendered inside a tab. */
export const sessionTabScopeId = (tabId: string): string => `tab:${tabId}`;

/**
 * Session tabs of the layout in pane order, with the one whose composer was
 * used last moved to the front: when another pane sends content "to the
 * session", that is the conversation the user was just in.
 */
export function listSessionTargets(
  root: PaneNode,
  activeScopeId: string | null,
  titleOf: (tab: Tab) => string,
): SessionTarget[] {
  const targets = allLeaves(root).flatMap((leaf) =>
    leaf.tabs
      .filter((tab) => tab.kind.type === "session")
      .map((tab) => ({ tabId: tab.id, leafId: leaf.id, title: titleOf(tab) })),
  );
  const lastUsed = targets.findIndex(
    (target) => sessionTabScopeId(target.tabId) === activeScopeId,
  );
  if (lastUsed <= 0) return targets;
  return [
    targets[lastUsed],
    ...targets.slice(0, lastUsed),
    ...targets.slice(lastUsed + 1),
  ];
}
