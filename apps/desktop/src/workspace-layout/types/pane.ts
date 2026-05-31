/**
 * Binary split tree describing the center pane area. Each split has exactly
 * two children, mirroring VSCode's `EditorGroup` split model. Same
 * direction adjacent splits are flattened at render time, not in storage,
 * which keeps state simpler at the cost of a single tree-walk on layout.
 */

import type { Tab } from "./tab";

export type SplitDirection = "h" | "v";

export interface PaneLeaf {
  type: "leaf";
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
}

export interface PaneSplit {
  type: "split";
  id: string;
  direction: SplitDirection;
  /**
   * Percentages summing to 100. children[0] is left/top, children[1] is
   * right/bottom. Resize handles mutate this in place.
   */
  sizes: [number, number];
  children: [PaneNode, PaneNode];
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLayout {
  root: PaneNode;
  focusedPaneId: string;
}

/**
 * Edge of an existing leaf where a dragged tab can be dropped to create a
 * new split. `center` means "merge into the existing leaf as a new tab".
 */
export type DropEdge = "center" | "left" | "right" | "top" | "bottom";
