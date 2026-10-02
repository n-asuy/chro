import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockState } from "../types";
import { DEFAULT_DOCK_WIDTH } from "../types";

const persistenceMock = vi.hoisted(() => ({
  loadedDock: null as DockState | null,
  loadDock: vi.fn(),
  saveDock: vi.fn(),
}));

vi.mock("../lib/persistence", () => ({
  loadDock: vi.fn((projectId?: string) => {
    persistenceMock.loadDock(projectId);
    return persistenceMock.loadedDock;
  }),
  saveDock: vi.fn((dock: DockState) => persistenceMock.saveDock(dock)),
}));

import { useDockStore } from "./dock-store";

function resetStore() {
  useDockStore.setState({
    projectId: null,
    hydrated: false,
    activePanel: "projects",
    width: DEFAULT_DOCK_WIDTH,
    collapsed: false,
    mode: "inbox",
  });
}

describe("useDockStore", () => {
  beforeEach(() => {
    persistenceMock.loadedDock = null;
    persistenceMock.loadDock.mockClear();
    persistenceMock.saveDock.mockClear();
    resetStore();
  });

  it("keeps the left dock width stable when switching projects", () => {
    persistenceMock.loadedDock = {
      activePanel: "projects",
      width: 360,
      collapsed: false,
    };

    useDockStore.getState().bindProject("project-a");

    expect(useDockStore.getState().width).toBe(360);
    expect(persistenceMock.loadDock).toHaveBeenCalledTimes(1);
    expect(persistenceMock.loadDock).toHaveBeenCalledWith("project-a");

    persistenceMock.loadedDock = {
      activePanel: "projects",
      width: 220,
      collapsed: false,
    };

    useDockStore.getState().bindProject("project-b");

    expect(useDockStore.getState().projectId).toBe("project-b");
    expect(useDockStore.getState().width).toBe(360);
    expect(persistenceMock.loadDock).toHaveBeenCalledTimes(1);
  });

  it("saves the migrated left dock state to the global dock key", () => {
    persistenceMock.loadedDock = {
      activePanel: "projects",
      width: 340,
      collapsed: false,
    };

    useDockStore.getState().bindProject("project-a");

    expect(persistenceMock.saveDock).toHaveBeenCalledWith({
      activePanel: "projects",
      width: 340,
      collapsed: false,
      mode: "inbox",
    });
  });

  it("restores the left panel mode and defaults older payloads to inbox", () => {
    persistenceMock.loadedDock = {
      activePanel: "projects",
      width: 300,
      collapsed: false,
      mode: "map",
    };
    useDockStore.getState().bindProject("project-a");
    expect(useDockStore.getState().mode).toBe("map");

    resetStore();
    persistenceMock.loadedDock = {
      activePanel: "projects",
      width: 300,
      collapsed: false,
    };
    useDockStore.getState().bindProject("project-a");
    expect(useDockStore.getState().mode).toBe("inbox");
  });

  it("switching mode reopens a collapsed dock and persists the mode", () => {
    useDockStore.getState().bindProject("project-a");
    useDockStore.getState().setCollapsed(true);
    persistenceMock.saveDock.mockClear();

    useDockStore.getState().setMode("map");

    const state = useDockStore.getState();
    expect(state.mode).toBe("map");
    expect(state.collapsed).toBe(false);
    expect(state.activePanel).toBe("projects");
    expect(persistenceMock.saveDock).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "map", collapsed: false }),
    );
  });
});
