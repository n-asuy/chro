export type {
  DockPanelKind,
  DockState,
  LeftDockPanelKind,
  RightDockPanelKind,
} from "./dock";
export {
  DEFAULT_DOCK_WIDTH,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
} from "./dock";
export type {
  DropEdge,
  PaneLayout,
  PaneLeaf,
  PaneNode,
  PaneSplit,
  SplitDirection,
} from "./pane";
export type {
  Tab,
  TabKey,
  TabKind,
  TabKindType,
} from "./tab";
export { isDuplicableKind, tabKey } from "./tab";
