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
    closeFocusTargets: {},
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

  it("restores the previously focused tab when a return-focus tab closes", () => {
    const store = useLayoutStore.getState();
    const sessionId = store.openTab({ type: "session", taskId: "task-1" });
    const diffId = store.openTab({ type: "diff", runId: "run-1" });
    store.openTab({ type: "browser" });

    const leafId = useLayoutStore.getState().layout.focusedPaneId;
    useLayoutStore.getState().setActiveTab(leafId, sessionId);
    expect(
      useLayoutStore
        .getState()
        .openTab(
          { type: "diff", runId: "run-1" },
          { returnFocusOnClose: true },
        ),
    ).toBe(diffId);

    useLayoutStore.getState().closeTab(diffId);

    const { layout } = useLayoutStore.getState();
    const focusedLeaf = allLeaves(layout.root).find(
      (leaf) => leaf.id === layout.focusedPaneId,
    );

    expect(focusedLeaf?.activeTabId).toBe(sessionId);
  });

  it("keeps an existing draft when a directory dispatch opens another project", () => {
    const store = useLayoutStore.getState();
    store.bindProject("project-b");
    store.openTab({ type: "session", homeDir: "existing-draft" });
    const saved = useLayoutStore.getState().layout;
    store.bindProject("project-a");
    persistenceMock.loadedLayout = saved;

    store.bindProject("project-b", {
      initialTab: { type: "session", homeDir: "docs" },
      freshSession: true,
    });
    const { layout } = useLayoutStore.getState();
    const leaf = allLeaves(layout.root).find(
      (entry) => entry.id === layout.focusedPaneId,
    )!;
    expect(
      leaf.tabs
        .filter((tab) => tab.kind.type === "session")
        .map((tab) => tab.kind),
    ).toEqual([
      { type: "session", homeDir: "existing-draft" },
      { type: "session", homeDir: "docs" },
    ]);
    expect(leaf.tabs.find((tab) => tab.id === leaf.activeTabId)?.kind).toEqual({
      type: "session",
      homeDir: "docs",
    });
  });

  it("restores a scoped draft from a bare session URL without replacing its address", () => {
    const store = useLayoutStore.getState();
    store.bindProject("project-b");
    store.openTab({ type: "session", homeDir: "older-draft" });
    const draftId = store.openTab({ type: "session", homeDir: "docs" });
    const saved = useLayoutStore.getState().layout;
    store.unbind();
    persistenceMock.loadedLayout = saved;
    store.bindProject("project-b", { initialTab: { type: "session" } });
    const tabs = allLeaves(useLayoutStore.getState().layout.root).flatMap(
      (leaf) => leaf.tabs,
    );
    expect(tabs.filter((tab) => tab.kind.type === "session")).toEqual([
      expect.objectContaining({
        kind: { type: "session", homeDir: "older-draft" },
      }),
      expect.objectContaining({
        id: draftId,
        kind: { type: "session", homeDir: "docs" },
      }),
    ]);
    const { layout } = useLayoutStore.getState();
    expect(
      allLeaves(layout.root).find((leaf) => leaf.id === layout.focusedPaneId)
        ?.activeTabId,
    ).toBe(draftId);
  });

  it("returns to the previous screen after a transient file tab closes", () => {
    const store = useLayoutStore.getState();
    const sessionId = store.openTab({ type: "session", taskId: "task-1" });
    const fileId = store.openTab(
      { type: "file", path: "preview.html" },
      { returnFocusOnClose: true },
    );

    useLayoutStore.getState().closeTab(fileId);

    const { layout } = useLayoutStore.getState();
    const focusedLeaf = allLeaves(layout.root).find(
      (leaf) => leaf.id === layout.focusedPaneId,
    );

    expect(focusedLeaf?.activeTabId).toBe(sessionId);
    expect(focusedLeaf?.tabs.some((tab) => tab.id === fileId)).toBe(false);
  });
});
