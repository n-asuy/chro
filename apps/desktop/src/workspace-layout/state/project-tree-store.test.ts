import { beforeEach, describe, expect, it, vi } from "vitest";

const uiStateMock = vi.hoisted(() => ({
  ready: true,
  storedValue: null as unknown,
  setUiValue: vi.fn(),
}));

vi.mock("@/lib/ui-state-client", () => ({
  getUiValue: vi.fn(() => (uiStateMock.ready ? uiStateMock.storedValue : null)),
  isUiStateReady: vi.fn(() => uiStateMock.ready),
  setUiValue: vi.fn((key: string, value: unknown) => {
    uiStateMock.storedValue = value;
    uiStateMock.setUiValue(key, value);
  }),
}));

import { useProjectTreeStore } from "./project-tree-store";

function resetStore() {
  useProjectTreeStore.setState({
    expanded: new Set<string>(),
    knownProjectIds: new Set<string>(),
    hydrated: false,
  });
}

function persistedState(
  expandedProjectIds: string[],
  knownProjectIds: string[] = expandedProjectIds,
) {
  return {
    version: 1,
    expandedProjectIds,
    knownProjectIds,
  };
}

describe("useProjectTreeStore", () => {
  beforeEach(() => {
    uiStateMock.ready = true;
    uiStateMock.storedValue = null;
    uiStateMock.setUiValue.mockClear();
    resetStore();
  });

  it("waits until ui-state is ready before hydrating", () => {
    uiStateMock.ready = false;

    expect(useProjectTreeStore.getState().hydrate()).toBe(false);

    expect(useProjectTreeStore.getState().hydrated).toBe(false);
    expect(uiStateMock.setUiValue).not.toHaveBeenCalled();
  });

  it("hydrates expanded and known project ids", () => {
    uiStateMock.storedValue = persistedState(
      ["project-a"],
      ["project-a", "project-b"],
    );

    expect(useProjectTreeStore.getState().hydrate()).toBe(true);

    expect(useProjectTreeStore.getState().isExpanded("project-a")).toBe(true);
    expect(useProjectTreeStore.getState().isExpanded("project-b")).toBe(false);

    useProjectTreeStore.getState().ensureExpanded("project-b");
    expect(useProjectTreeStore.getState().isExpanded("project-b")).toBe(false);

    useProjectTreeStore.getState().ensureExpanded("project-c");
    expect(useProjectTreeStore.getState().isExpanded("project-c")).toBe(true);
    expect(uiStateMock.storedValue).toEqual(
      persistedState(
        ["project-a", "project-c"],
        ["project-a", "project-b", "project-c"],
      ),
    );
  });

  it("persists collapsed projects so default expansion does not reopen them", () => {
    expect(useProjectTreeStore.getState().hydrate()).toBe(true);

    useProjectTreeStore.getState().ensureExpanded("active-project");
    expect(useProjectTreeStore.getState().isExpanded("active-project")).toBe(
      true,
    );

    useProjectTreeStore.getState().toggle("active-project");
    expect(useProjectTreeStore.getState().isExpanded("active-project")).toBe(
      false,
    );

    const savedAfterCollapse = uiStateMock.storedValue;
    resetStore();
    uiStateMock.storedValue = savedAfterCollapse;

    expect(useProjectTreeStore.getState().hydrate()).toBe(true);
    useProjectTreeStore.getState().ensureExpanded("active-project");

    expect(useProjectTreeStore.getState().isExpanded("active-project")).toBe(
      false,
    );
  });

  it("merges explicit pre-hydration expansions with persisted state", () => {
    uiStateMock.ready = false;
    useProjectTreeStore.getState().expand("pending-project");
    expect(uiStateMock.setUiValue).not.toHaveBeenCalled();

    uiStateMock.storedValue = persistedState(["stored-project"]);
    uiStateMock.ready = true;

    expect(useProjectTreeStore.getState().hydrate()).toBe(true);

    expect(useProjectTreeStore.getState().isExpanded("stored-project")).toBe(
      true,
    );
    expect(useProjectTreeStore.getState().isExpanded("pending-project")).toBe(
      true,
    );
    expect(uiStateMock.storedValue).toEqual(
      persistedState(
        ["stored-project", "pending-project"],
        ["stored-project", "pending-project"],
      ),
    );
  });
});
