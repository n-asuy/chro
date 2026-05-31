import { create } from "zustand";
import { loadRightDock, saveRightDock } from "../lib/persistence";
import {
  DEFAULT_DOCK_WIDTH,
  type DockState,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
  type RightDockPanelKind,
} from "../types";

/**
 * Right-side dock. Independent state from {@link useDockStore}, so a user
 * can keep e.g. file tree on the left and source control on the right at
 * the same time. Toggle chrome lives in the project tabs header instead
 * of a dedicated bottom bar — the right dock has no footer.
 */

interface RightDockActions {
  bindProject: (projectId: string) => void;
  setActivePanel: (panel: RightDockPanelKind | null) => void;
  togglePanel: (panel: RightDockPanelKind) => void;
  setWidth: (width: number) => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  focusSearchPanel: () => void;
}

interface RightDockStateExtra {
  projectId: string | null;
  hydrated: boolean;
  searchFocusToken: number;
}

interface RightDockStateInternal {
  activePanel: RightDockPanelKind | null;
  width: number;
  collapsed: boolean;
}

type RightDockStore = RightDockStateInternal &
  RightDockStateExtra &
  RightDockActions;

const initialDock: RightDockStateInternal = {
  activePanel: null,
  width: DEFAULT_DOCK_WIDTH,
  collapsed: true,
};

function persist(state: RightDockStore) {
  const payload: DockState = {
    activePanel: state.activePanel,
    width: state.width,
    collapsed: state.collapsed,
  };
  saveRightDock(payload);
}

function clampWidth(w: number): number {
  if (w < MIN_DOCK_WIDTH) return MIN_DOCK_WIDTH;
  if (w > MAX_DOCK_WIDTH) return MAX_DOCK_WIDTH;
  return Math.round(w);
}

const RIGHT_PANEL_KINDS: ReadonlySet<RightDockPanelKind> = new Set([
  "filetree",
  "search",
  "source-control",
]);

function isRightPanelKind(
  kind: DockState["activePanel"],
): kind is RightDockPanelKind {
  return kind !== null && RIGHT_PANEL_KINDS.has(kind as RightDockPanelKind);
}

export const useRightDockStore = create<RightDockStore>()((set, get) => ({
  projectId: null,
  hydrated: false,
  searchFocusToken: 0,
  ...initialDock,

  bindProject: (projectId) => {
    const state = get();
    if (state.projectId === projectId && state.hydrated) return;

    if (state.hydrated) {
      set({ projectId });
      return;
    }

    const persisted = loadRightDock(projectId);
    const restoredPanel = isRightPanelKind(persisted?.activePanel ?? null)
      ? (persisted?.activePanel as RightDockPanelKind)
      : initialDock.activePanel;
    const restoredWidth =
      persisted && Number.isFinite(persisted.width)
        ? clampWidth(persisted.width)
        : initialDock.width;
    set({
      projectId,
      hydrated: true,
      activePanel: restoredPanel,
      width: restoredWidth,
      collapsed: persisted?.collapsed ?? initialDock.collapsed,
    });

    if (persisted) persist(get());
  },

  setActivePanel: (panel) => {
    set({ activePanel: panel, collapsed: panel === null });
    persist(get());
  },

  togglePanel: (panel) => {
    const state = get();
    if (state.collapsed) {
      set({ activePanel: panel, collapsed: false });
    } else if (state.activePanel === panel) {
      set({ collapsed: true });
    } else {
      set({ activePanel: panel });
    }
    persist(get());
  },

  setWidth: (width) => {
    set({ width: clampWidth(width) });
    persist(get());
  },

  setCollapsed: (collapsed) => {
    set({ collapsed });
    persist(get());
  },

  toggleCollapsed: () => {
    set((prev) => ({ collapsed: !prev.collapsed }));
    persist(get());
  },

  focusSearchPanel: () => {
    set((prev) => ({
      activePanel: "search",
      collapsed: false,
      searchFocusToken: prev.searchFocusToken + 1,
    }));
    persist(get());
  },
}));
