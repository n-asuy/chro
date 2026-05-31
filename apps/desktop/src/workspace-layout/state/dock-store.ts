import { create } from "zustand";
import { loadDock, saveDock } from "../lib/persistence";
import {
  DEFAULT_DOCK_WIDTH,
  type LeftDockPanelKind,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
} from "../types";

interface LeftDockState {
  activePanel: LeftDockPanelKind | null;
  width: number;
  collapsed: boolean;
}

interface DockActions {
  bindProject: (projectId: string) => void;
  setActivePanel: (panel: LeftDockPanelKind | null) => void;
  setWidth: (width: number) => void;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
}

interface DockStateExtra {
  projectId: string | null;
  hydrated: boolean;
}

type DockStore = LeftDockState & DockStateExtra & DockActions;

const initialDock: LeftDockState = {
  activePanel: "projects",
  width: DEFAULT_DOCK_WIDTH,
  collapsed: false,
};

function persist(state: DockStore) {
  saveDock({
    activePanel: state.activePanel,
    width: state.width,
    collapsed: state.collapsed,
  });
}

function clampWidth(w: number): number {
  if (w < MIN_DOCK_WIDTH) return MIN_DOCK_WIDTH;
  if (w > MAX_DOCK_WIDTH) return MAX_DOCK_WIDTH;
  return Math.round(w);
}

export const useDockStore = create<DockStore>()((set, get) => ({
  projectId: null,
  hydrated: false,
  ...initialDock,

  bindProject: (projectId) => {
    const state = get();
    if (state.projectId === projectId && state.hydrated) return;

    // Left dock state is app-global; project id is only tracked for legacy
    // project-scoped persistence migration during the first bind.
    if (state.hydrated) {
      set({ projectId });
      return;
    }

    const persisted = loadDock(projectId);
    const restoredWidth =
      persisted && Number.isFinite(persisted.width)
        ? clampWidth(persisted.width)
        : initialDock.width;
    set({
      projectId,
      hydrated: true,
      activePanel: persisted?.collapsed ? null : initialDock.activePanel,
      width: restoredWidth,
      collapsed: persisted?.collapsed ?? initialDock.collapsed,
    });

    if (persisted) persist(get());
  },

  setActivePanel: (panel) => {
    set({ activePanel: panel, collapsed: panel === null });
    persist(get());
  },

  setWidth: (width) => {
    set({ width: clampWidth(width) });
    persist(get());
  },

  setCollapsed: (collapsed) => {
    set({ collapsed, activePanel: collapsed ? null : "projects" });
    persist(get());
  },

  toggleCollapsed: () => {
    set((prev) => {
      const collapsed = !prev.collapsed;
      return { collapsed, activePanel: collapsed ? null : "projects" };
    });
    persist(get());
  },
}));
