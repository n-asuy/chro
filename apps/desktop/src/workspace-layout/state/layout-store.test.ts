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
    focusHistory: [],
  });
}

function focusedTabId(): string | null {
  const { layout } = useLayoutStore.getState();
  return (
    allLeaves(layout.root).find((leaf) => leaf.id === layout.focusedPaneId)
      ?.activeTabId ?? null
  );
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

  it("restores the previously focused tab when a refocused tab closes", () => {
    const store = useLayoutStore.getState();
    const sessionId = store.openTab({ type: "session", taskId: "task-1" });
    const diffId = store.openTab({ type: "diff", runId: "run-1" });
    store.openTab({ type: "browser" });

    const leafId = useLayoutStore.getState().layout.focusedPaneId;
    useLayoutStore.getState().setActiveTab(leafId, sessionId);
    expect(
      useLayoutStore.getState().openTab({ type: "diff", runId: "run-1" }),
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
    const fileId = store.openTab({ type: "file", path: "preview.html" });

    useLayoutStore.getState().closeTab(fileId);

    const { layout } = useLayoutStore.getState();
    const focusedLeaf = allLeaves(layout.root).find(
      (leaf) => leaf.id === layout.focusedPaneId,
    );

    expect(focusedLeaf?.activeTabId).toBe(sessionId);
    expect(focusedLeaf?.tabs.some((tab) => tab.id === fileId)).toBe(false);
  });

  it("returns to the previously viewed tab, not the positional neighbor", () => {
    const store = useLayoutStore.getState();
    const a = store.openTab({ type: "session", taskId: "task-a" });
    store.openTab({ type: "session", taskId: "task-b" });
    const c = store.openTab({ type: "session", taskId: "task-c" });
    const leafId = useLayoutStore.getState().layout.focusedPaneId;
    useLayoutStore.getState().setActiveTab(leafId, a);
    useLayoutStore.getState().setActiveTab(leafId, c);

    useLayoutStore.getState().closeTab(c);

    expect(focusedTabId()).toBe(a);
  });

  it("walks back through the focus history on repeated closes", () => {
    const store = useLayoutStore.getState();
    const a = store.openTab({ type: "session", taskId: "task-a" });
    const b = store.openTab({ type: "session", taskId: "task-b" });
    const c = store.openTab({ type: "session", taskId: "task-c" });
    const d = store.openTab({ type: "session", taskId: "task-d" });
    const leafId = useLayoutStore.getState().layout.focusedPaneId;
    for (const id of [b, d, a])
      useLayoutStore.getState().setActiveTab(leafId, id);

    useLayoutStore.getState().closeTab(a);
    expect(focusedTabId()).toBe(d);
    useLayoutStore.getState().closeTab(d);
    expect(focusedTabId()).toBe(b);
    useLayoutStore.getState().closeTab(b);
    expect(focusedTabId()).toBe(c);
  });

  it("returns focus to the previous pane when the closed tab was opened from it", () => {
    const store = useLayoutStore.getState();
    const session = store.openTab({ type: "session", taskId: "task-a" });
    const file = store.openTab({ type: "file", path: "notes.md" });
    const sessionLeaf = useLayoutStore.getState().layout.focusedPaneId;
    useLayoutStore.getState().splitWithTab(file, sessionLeaf, "right");
    const other = useLayoutStore.getState().openTab({ type: "browser" });
    useLayoutStore.getState().setActiveTab(sessionLeaf, session);
    const fileLeaf = allLeaves(useLayoutStore.getState().layout.root).find(
      (leaf) => leaf.tabs.some((tab) => tab.id === file),
    )!;
    useLayoutStore.getState().setActiveTab(fileLeaf.id, file);

    useLayoutStore.getState().closeTab(file);

    const { layout } = useLayoutStore.getState();
    expect(layout.focusedPaneId).toBe(sessionLeaf);
    expect(focusedTabId()).toBe(session);
    expect(
      allLeaves(layout.root).find((leaf) => leaf.id === fileLeaf.id)
        ?.activeTabId,
    ).toBe(other);
  });

  it("keeps focus where it is when an unfocused tab closes", () => {
    const store = useLayoutStore.getState();
    const a = store.openTab({ type: "session", taskId: "task-a" });
    const b = store.openTab({ type: "session", taskId: "task-b" });
    const leafId = useLayoutStore.getState().layout.focusedPaneId;
    useLayoutStore.getState().setActiveTab(leafId, a);

    useLayoutStore.getState().closeTab(b);

    expect(focusedTabId()).toBe(a);
  });

  it("falls back to the neighbor when no earlier tab was viewed", () => {
    const store = useLayoutStore.getState();
    store.bindProject("project-a");
    store.openTab({ type: "session", taskId: "task-a" });
    const b = store.openTab({ type: "session", taskId: "task-b" });
    const c = store.openTab({ type: "session", taskId: "task-c" });
    const saved = useLayoutStore.getState().layout;
    store.unbind();
    persistenceMock.loadedLayout = {
      ...saved,
      root: { ...saved.root, activeTabId: b } as PaneLayout["root"],
    };
    store.bindProject("project-a");

    useLayoutStore.getState().closeTab(b);

    expect(focusedTabId()).toBe(c);
  });
});
