export { LayoutShell } from "./components/layout-shell";
export { LeftDock } from "./components/left-dock";
export { PaneDndContext } from "./components/pane-dnd-context";
export { PaneTreeView } from "./components/pane-tree-view";
export { PaneContainer } from "./components/pane-container";
export { TabBar } from "./components/tab-bar";

export {
  useLayoutStore,
  useLayoutSelector,
} from "./state/layout-store";
export { useDockStore } from "./state/dock-store";

export {
  getPaneItem,
  listPaneItems,
  registerPaneItem,
} from "./registry";
export type {
  PaneItemDescriptor,
  PaneItemRenderProps,
} from "./registry";

export type {
  DockPanelKind,
  DockState,
  DropEdge,
  PaneLayout,
  PaneLeaf,
  PaneNode,
  PaneSplit,
  SplitDirection,
  Tab,
  TabKey,
  TabKind,
  TabKindType,
} from "./types";
export {
  DEFAULT_DOCK_WIDTH,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
  isDuplicableKind,
  tabKey,
} from "./types";

export {
  loadDock,
  loadLayout,
  saveDock,
  saveLayout,
} from "./lib/persistence";
export {
  allLeaves,
  createInitialLayout,
  createLeaf,
  createSplit,
  findLeaf,
  findLeafContainingTab,
  firstLeaf,
} from "./lib/pane-tree";
