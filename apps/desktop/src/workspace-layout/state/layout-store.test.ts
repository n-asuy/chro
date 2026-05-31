import { beforeEach, describe, expect, it, vi } from "vitest";
import { allLeaves, createInitialLayout } from "../lib/pane-tree";
import type { PaneLayout } from "../types";

const persistenceMock = vi.hoisted(() => ({
  loadedLayout: null as PaneLayout | null,
  loadLayout: vi.fn(),
  saveLayout: vi.fn(),
}));

vi.mock("../lib/persistence", () => ({
  loadLayout: vi.fn((projectId: string) => {
    persistenceMock.loadLayout(projectId);
    return persistenceMock.loadedLayout;
  }),
  saveLayout: vi.fn((projectId: string, layout: PaneLayout) =>
    persistenceMock.saveLayout(projectId, layout),
  ),
}));

import { useLayoutStore } from "./layout-store";

function resetStore() {
  useLayoutStore.setState({
    projectId: null,
    layout: createInitialLayout(),
  });
}

describe("useLayoutStore", () => {
  beforeEach(() => {
    persistenceMock.loadedLayout = null;
    persistenceMock.loadLayout.mockClear();
    persistenceMock.saveLayout.mockClear();
    resetStore();
  });

  it("binds a new project with the route tab already focused", () => {
    useLayoutStore.getState().bindProject("project-a", {
      initialTab: { type: "session", taskId: "task-1" },
    });

    const { layout } = useLayoutStore.getState();
    const focusedLeaf = allLeaves(layout.root).find(
      (leaf) => leaf.id === layout.focusedPaneId,
    );
    const focusedTab = focusedLeaf?.tabs.find(
      (tab) => tab.id === focusedLeaf.activeTabId,
    );

    expect(focusedTab?.kind).toEqual({ type: "session", taskId: "task-1" });
  });
});
