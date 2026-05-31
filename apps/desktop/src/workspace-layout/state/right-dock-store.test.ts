import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockState } from "../types";
import { DEFAULT_DOCK_WIDTH } from "../types";

const persistenceMock = vi.hoisted(() => ({
  loadedDock: null as DockState | null,
  loadRightDock: vi.fn(),
  saveRightDock: vi.fn(),
}));

vi.mock("../lib/persistence", () => ({
  loadRightDock: vi.fn((projectId?: string) => {
    persistenceMock.loadRightDock(projectId);
    return persistenceMock.loadedDock;
  }),
  saveRightDock: vi.fn((dock: DockState) =>
    persistenceMock.saveRightDock(dock),
  ),
}));

import { useRightDockStore } from "./right-dock-store";

function resetStore() {
  useRightDockStore.setState({
    projectId: null,
    hydrated: false,
    searchFocusToken: 0,
    activePanel: null,
    width: DEFAULT_DOCK_WIDTH,
    collapsed: true,
  });
}

describe("useRightDockStore", () => {
  beforeEach(() => {
    persistenceMock.loadedDock = null;
    persistenceMock.loadRightDock.mockClear();
    persistenceMock.saveRightDock.mockClear();
    resetStore();
  });

  it("keeps the right dock chrome stable when switching projects", () => {
    persistenceMock.loadedDock = {
      activePanel: "filetree",
      width: 360,
      collapsed: false,
    };

    useRightDockStore.getState().bindProject("project-a");

    expect(useRightDockStore.getState().activePanel).toBe("filetree");
    expect(useRightDockStore.getState().width).toBe(360);
    expect(useRightDockStore.getState().collapsed).toBe(false);
    expect(persistenceMock.loadRightDock).toHaveBeenCalledTimes(1);
    expect(persistenceMock.loadRightDock).toHaveBeenCalledWith("project-a");

    persistenceMock.loadedDock = {
      activePanel: "search",
      width: 220,
      collapsed: true,
    };

    useRightDockStore.getState().bindProject("project-b");

    expect(useRightDockStore.getState().projectId).toBe("project-b");
    expect(useRightDockStore.getState().activePanel).toBe("filetree");
    expect(useRightDockStore.getState().width).toBe(360);
    expect(useRightDockStore.getState().collapsed).toBe(false);
    expect(persistenceMock.loadRightDock).toHaveBeenCalledTimes(1);
  });

  it("saves the migrated right dock state to the global dock key", () => {
    persistenceMock.loadedDock = {
      activePanel: "source-control",
      width: 340,
      collapsed: false,
    };

    useRightDockStore.getState().bindProject("project-a");

    expect(persistenceMock.saveRightDock).toHaveBeenCalledWith({
      activePanel: "source-control",
      width: 340,
      collapsed: false,
    });
  });
});
