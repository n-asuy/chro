import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  allLeaves,
  createInitialLayout,
  createLeaf,
  findLeaf,
  findLeafContainingTab,
  firstLeaf,
  focusableLeafIdAfterRemoval,
  mapLeaf,
  replaceLeaf,
  splitLeaf,
} from "../lib/pane-tree";
import { loadLayout, saveLayout } from "../lib/persistence";
import type {
  DropEdge,
  PaneLayout,
  PaneLeaf,
  PaneNode,
  SplitDirection,
  Tab,
  TabKind,
} from "../types";
import { isDuplicableKind, tabKey } from "../types";

interface LayoutState {
  /** Currently bound project; null until `bindProject` runs */
  projectId: string | null;
  layout: PaneLayout;
  closeFocusTargets: Record<string, FocusTarget>;
}

interface LayoutActions {
  bindProject: (
    projectId: string,
    options?: { initialTab?: TabKind | null },
  ) => void;
  unbind: () => void;

  /** Open a tab in the focused pane (or a specific leaf), focusing duplicates */
  openTab: (
    kind: TabKind,
    options?: {
      title?: string;
      iconName?: string;
      targetLeafId?: string;
      activate?: boolean;
      returnFocusOnClose?: boolean;
    },
  ) => string;

  closeTab: (tabId: string) => void;
  closeOthers: (tabId: string) => void;
  closeToRight: (tabId: string) => void;
  closeAllInLeaf: (leafId: string) => void;

  setActiveTab: (leafId: string, tabId: string) => void;
  setFocusedPane: (leafId: string) => void;

  moveTab: (tabId: string, target: { leafId: string; index?: number }) => void;

  splitWithTab: (
    sourceTabId: string,
    targetLeafId: string,
    edge: Exclude<DropEdge, "center">,
  ) => void;

  resizeSplit: (splitId: string, sizes: [number, number]) => void;

  /** Update tab metadata (title/dirty/icon) without remounting content */
  patchTab: (
    tabId: string,
    patch: Partial<Pick<Tab, "title" | "iconName" | "dirty" | "pinned">>,
  ) => void;

  /**
   * Replace a tab's kind in place. Used when the underlying resource transitions
   * — e.g. a "new session" tab becoming a concrete session once a prompt is
   * submitted — so the same tab id keeps its position rather than spawning a
   * second tab.
   */
  setTabKind: (tabId: string, kind: TabKind) => void;
}

type LayoutStore = LayoutState & LayoutActions;

interface FocusTarget {
  leafId: string;
  tabId: string;
}

function persist(state: LayoutState) {
  if (state.projectId) saveLayout(state.projectId, state.layout);
}

let tabSeq = 0;
function nextTabId(): string {
  tabSeq += 1;
  return `tab_${Date.now().toString(36)}_${tabSeq.toString(36)}`;
}

function findTabInLayout(
  layout: PaneLayout,
  predicate: (tab: Tab) => boolean,
): { leaf: PaneLeaf; tab: Tab } | null {
  for (const leaf of allLeaves(layout.root)) {
    const tab = leaf.tabs.find(predicate);
    if (tab) return { leaf, tab };
  }
  return null;
}

function getFocusedTabTarget(layout: PaneLayout): FocusTarget | null {
  const leaf = findLeaf(layout.root, layout.focusedPaneId);
  if (!leaf?.activeTabId) return null;
  return { leafId: leaf.id, tabId: leaf.activeTabId };
}

function focusTargetIfPresent(
  layout: PaneLayout,
  target: FocusTarget,
): PaneLayout {
  const leaf = findLeaf(layout.root, target.leafId);
  if (!leaf?.tabs.some((tab) => tab.id === target.tabId)) return layout;
  return {
    root: mapLeaf(layout.root, target.leafId, (l) => ({
      ...l,
      activeTabId: target.tabId,
    })),
    focusedPaneId: target.leafId,
  };
}

function omitCloseFocusTarget(
  targets: Record<string, FocusTarget>,
  tabId: string,
): Record<string, FocusTarget> {
  if (!(tabId in targets)) return targets;
  const { [tabId]: _, ...rest } = targets;
  return rest;
}

function focusOrInsertTab(layout: PaneLayout, kind: TabKind): PaneLayout {
  const key = tabKey(kind);
  const existing = findTabInLayout(layout, (tab) => tabKey(tab.kind) === key);
  if (existing) {
    return {
      root: mapLeaf(layout.root, existing.leaf.id, (leaf) => ({
        ...leaf,
        tabs: leaf.tabs.map((tab) =>
          tab.id === existing.tab.id
            ? { ...tab, kind, title: defaultTitle(kind) }
            : tab,
        ),
        activeTabId: existing.tab.id,
      })),
      focusedPaneId: existing.leaf.id,
    };
  }

  const targetLeaf =
    findLeaf(layout.root, layout.focusedPaneId) ?? firstLeaf(layout.root);
  const tab: Tab = {
    id: nextTabId(),
    kind,
    title: defaultTitle(kind),
  };
  return {
    root: mapLeaf(layout.root, targetLeaf.id, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, tab],
      activeTabId: tab.id,
    })),
    focusedPaneId: targetLeaf.id,
  };
}

function withRoot(state: LayoutState, root: PaneNode | null): LayoutState {
  if (!root) {
    const fresh = createInitialLayout();
    return {
      ...state,
      layout: fresh,
    };
  }
  return {
    ...state,
    layout: { ...state.layout, root },
  };
}

export const useLayoutStore = create<LayoutStore>()((set, get) => ({
  projectId: null,
  layout: createInitialLayout(),
  closeFocusTargets: {},

  bindProject: (projectId, options = {}) => {
    const state = get();
    if (state.projectId === projectId) return;
    const persisted = loadLayout(projectId);
    const nextLayout =
      persisted ??
      (state.projectId === null ? state.layout : createInitialLayout());
    set({
      projectId,
      layout: options.initialTab
        ? focusOrInsertTab(nextLayout, options.initialTab)
        : nextLayout,
      closeFocusTargets: {},
    });
    if (options.initialTab) persist(get());
  },

  unbind: () =>
    set({
      projectId: null,
      layout: createInitialLayout(),
      closeFocusTargets: {},
    }),

  openTab: (kind, options = {}) => {
    const state = get();
    const key = tabKey(kind);
    const duplicable =
      isDuplicableKind(kind.type) || (kind.type === "session" && !kind.taskId);
    const returnTarget =
      options.returnFocusOnClose && options.activate !== false
        ? getFocusedTabTarget(state.layout)
        : null;

    if (!duplicable) {
      const existing = findTabInLayout(
        state.layout,
        (t) => tabKey(t.kind) === key,
      );
      if (existing) {
        const { leaf, tab } = existing;
        if (options.activate !== false) {
          set((prev) => ({
            ...prev,
            closeFocusTargets:
              returnTarget && returnTarget.tabId !== tab.id
                ? { ...prev.closeFocusTargets, [tab.id]: returnTarget }
                : prev.closeFocusTargets,
            layout: {
              root: mapLeaf(prev.layout.root, leaf.id, (l) => ({
                ...l,
                activeTabId: tab.id,
              })),
              focusedPaneId: leaf.id,
            },
          }));
          persist(get());
        }
        return tab.id;
      }
    }

    const tab: Tab = {
      id: nextTabId(),
      kind,
      title: options.title ?? defaultTitle(kind),
      iconName: options.iconName,
    };
    const targetLeafId = options.targetLeafId ?? state.layout.focusedPaneId;
    const leaf =
      findLeaf(state.layout.root, targetLeafId) ?? firstLeaf(state.layout.root);

    set((prev) => ({
      ...prev,
      closeFocusTargets:
        returnTarget && returnTarget.tabId !== tab.id
          ? { ...prev.closeFocusTargets, [tab.id]: returnTarget }
          : prev.closeFocusTargets,
      layout: {
        root: mapLeaf(prev.layout.root, leaf.id, (l) => ({
          ...l,
          tabs: [...l.tabs, tab],
          activeTabId: options.activate === false ? l.activeTabId : tab.id,
        })),
        focusedPaneId: leaf.id,
      },
    }));
    persist(get());
    return tab.id;
  },

  closeTab: (tabId) => {
    const state = get();
    const owner = findLeafContainingTab(state.layout.root, tabId);
    if (!owner) return;
    const remaining = owner.tabs.filter((t) => t.id !== tabId);
    let nextActive = owner.activeTabId;
    const closingActiveTab = owner.activeTabId === tabId;
    if (closingActiveTab) {
      const closingIdx = owner.tabs.findIndex((t) => t.id === tabId);
      const fallback =
        remaining[closingIdx] ?? remaining[closingIdx - 1] ?? remaining[0];
      nextActive = fallback?.id ?? null;
    }
    let nextLayout: PaneLayout;
    if (remaining.length === 0) {
      // Empty leaf: collapse it from the tree unless it's the only leaf
      const root = state.layout.root;
      if (root.type === "leaf" && root.id === owner.id) {
        nextLayout = {
          root: createLeaf({ id: owner.id }),
          focusedPaneId: owner.id,
        };
      } else {
        const nextRoot = replaceLeaf(root, owner.id, null);
        const fallbackRoot = createInitialLayout().root;
        const resolvedRoot = nextRoot ?? fallbackRoot;
        nextLayout = {
          root: resolvedRoot,
          focusedPaneId: focusableLeafIdAfterRemoval(
            resolvedRoot,
            owner.id,
            state.layout.focusedPaneId,
          ),
        };
      }
    } else {
      nextLayout = {
        ...state.layout,
        root: mapLeaf(state.layout.root, owner.id, (l) => ({
          ...l,
          tabs: remaining,
          activeTabId: nextActive,
        })),
      };
    }
    const returnTarget = closingActiveTab
      ? state.closeFocusTargets[tabId]
      : undefined;
    if (returnTarget) {
      nextLayout = focusTargetIfPresent(nextLayout, returnTarget);
    }
    set((prev) => ({
      ...prev,
      closeFocusTargets: omitCloseFocusTarget(prev.closeFocusTargets, tabId),
      layout: nextLayout,
    }));
    persist(get());
  },

  closeOthers: (tabId) => {
    const state = get();
    const owner = findLeafContainingTab(state.layout.root, tabId);
    if (!owner) return;
    set((prev) => ({
      ...prev,
      layout: {
        ...prev.layout,
        root: mapLeaf(prev.layout.root, owner.id, (l) => ({
          ...l,
          tabs: l.tabs.filter((t) => t.id === tabId || t.pinned),
          activeTabId: tabId,
        })),
      },
    }));
    persist(get());
  },

  closeToRight: (tabId) => {
    const state = get();
    const owner = findLeafContainingTab(state.layout.root, tabId);
    if (!owner) return;
    const idx = owner.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    set((prev) => ({
      ...prev,
      layout: {
        ...prev.layout,
        root: mapLeaf(prev.layout.root, owner.id, (l) => ({
          ...l,
          tabs: l.tabs.filter((t, i) => i <= idx || t.pinned),
          activeTabId:
            l.activeTabId &&
            l.tabs.findIndex((t) => t.id === l.activeTabId) > idx
              ? tabId
              : l.activeTabId,
        })),
      },
    }));
    persist(get());
  },

  closeAllInLeaf: (leafId) => {
    const state = get();
    const owner = findLeaf(state.layout.root, leafId);
    if (!owner) return;
    const pinned = owner.tabs.filter((t) => t.pinned);
    if (pinned.length > 0) {
      set((prev) => ({
        ...prev,
        layout: {
          ...prev.layout,
          root: mapLeaf(prev.layout.root, owner.id, (l) => ({
            ...l,
            tabs: pinned,
            activeTabId: pinned[0]?.id ?? null,
          })),
        },
      }));
    } else {
      const root = state.layout.root;
      if (root.type === "leaf" && root.id === owner.id) {
        set((prev) => ({
          ...prev,
          layout: {
            root: createLeaf({ id: owner.id }),
            focusedPaneId: owner.id,
          },
        }));
      } else {
        const nextRoot = replaceLeaf(root, owner.id, null);
        set((prev) => ({
          ...prev,
          layout: {
            root: nextRoot ?? createInitialLayout().root,
            focusedPaneId: focusableLeafIdAfterRemoval(
              nextRoot ?? createInitialLayout().root,
              owner.id,
              prev.layout.focusedPaneId,
            ),
          },
        }));
      }
    }
    persist(get());
  },

  setActiveTab: (leafId, tabId) => {
    set((prev) => ({
      ...prev,
      layout: {
        root: mapLeaf(prev.layout.root, leafId, (l) =>
          l.tabs.some((t) => t.id === tabId) ? { ...l, activeTabId: tabId } : l,
        ),
        focusedPaneId: leafId,
      },
    }));
    persist(get());
  },

  setFocusedPane: (leafId) => {
    set((prev) => ({
      ...prev,
      layout: { ...prev.layout, focusedPaneId: leafId },
    }));
    persist(get());
  },

  moveTab: (tabId, target) => {
    const state = get();
    const owner = findLeafContainingTab(state.layout.root, tabId);
    if (!owner) return;
    const tab = owner.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const dest = findLeaf(state.layout.root, target.leafId);
    if (!dest) return;

    if (owner.id === dest.id) {
      // reorder within same leaf
      const without = owner.tabs.filter((t) => t.id !== tabId);
      const insertAt = clampIndex(
        target.index ?? without.length,
        without.length,
      );
      without.splice(insertAt, 0, tab);
      set((prev) => ({
        ...prev,
        layout: {
          ...prev.layout,
          root: mapLeaf(prev.layout.root, owner.id, (l) => ({
            ...l,
            tabs: without,
            activeTabId: tabId,
          })),
        },
      }));
      persist(get());
      return;
    }

    // remove from owner; insert into dest
    let nextRoot: PaneNode | null = mapLeaf(
      state.layout.root,
      owner.id,
      (l) => {
        const tabs = l.tabs.filter((t) => t.id !== tabId);
        const closingIdx = l.tabs.findIndex((t) => t.id === tabId);
        const fallback = tabs[closingIdx] ?? tabs[closingIdx - 1] ?? tabs[0];
        return {
          ...l,
          tabs,
          activeTabId:
            l.activeTabId === tabId ? fallback?.id ?? null : l.activeTabId,
        };
      },
    );
    // collapse owner if emptied
    const ownerAfter = findLeaf(nextRoot, owner.id);
    if (ownerAfter && ownerAfter.tabs.length === 0) {
      const root = nextRoot;
      if (root.type === "leaf" && root.id === owner.id) {
        // single-leaf root just stays empty
      } else {
        nextRoot = replaceLeaf(root, owner.id, null);
      }
    }
    if (!nextRoot) nextRoot = createInitialLayout().root;
    nextRoot = mapLeaf(nextRoot, dest.id, (l) => {
      const tabs = [...l.tabs];
      const insertAt = clampIndex(target.index ?? tabs.length, tabs.length);
      tabs.splice(insertAt, 0, tab);
      return { ...l, tabs, activeTabId: tabId };
    });
    set((prev) => ({
      ...prev,
      layout: {
        root: nextRoot!,
        focusedPaneId: dest.id,
      },
    }));
    persist(get());
  },

  splitWithTab: (sourceTabId, targetLeafId, edge) => {
    const state = get();
    const owner = findLeafContainingTab(state.layout.root, sourceTabId);
    if (!owner) return;
    const sourceTab = owner.tabs.find((t) => t.id === sourceTabId);
    if (!sourceTab) return;
    const direction: SplitDirection =
      edge === "left" || edge === "right" ? "h" : "v";
    const side: "before" | "after" =
      edge === "left" || edge === "top" ? "before" : "after";

    const split = splitLeaf(state.layout.root, targetLeafId, direction, side);
    if (!split) return;
    let nextRoot: PaneNode = split.root;

    // remove source from owner (after split: owner may be the target itself)
    nextRoot = mapLeaf(nextRoot, owner.id, (l) => {
      if (l.id === split.newLeafId) return l; // shouldn't happen
      const tabs = l.tabs.filter((t) => t.id !== sourceTabId);
      const closingIdx = l.tabs.findIndex((t) => t.id === sourceTabId);
      const fallback = tabs[closingIdx] ?? tabs[closingIdx - 1] ?? tabs[0];
      return {
        ...l,
        tabs,
        activeTabId:
          l.activeTabId === sourceTabId ? fallback?.id ?? null : l.activeTabId,
      };
    });

    // collapse owner if empty
    const ownerAfter = findLeaf(nextRoot, owner.id);
    if (
      ownerAfter &&
      ownerAfter.tabs.length === 0 &&
      owner.id !== split.newLeafId
    ) {
      const root = nextRoot;
      if (!(root.type === "leaf" && root.id === owner.id)) {
        const collapsed = replaceLeaf(root, owner.id, null);
        if (collapsed) nextRoot = collapsed;
      }
    }

    nextRoot = mapLeaf(nextRoot, split.newLeafId, (l) => ({
      ...l,
      tabs: [sourceTab],
      activeTabId: sourceTab.id,
    }));

    set((prev) => ({
      ...prev,
      layout: {
        root: nextRoot,
        focusedPaneId: split.newLeafId,
      },
    }));
    persist(get());
  },

  resizeSplit: (splitId, sizes) => {
    const update = (node: PaneNode): PaneNode => {
      if (node.type === "leaf") return node;
      if (node.id === splitId) return { ...node, sizes };
      const left = update(node.children[0]);
      const right = update(node.children[1]);
      if (left === node.children[0] && right === node.children[1]) return node;
      return { ...node, children: [left, right] };
    };
    set((prev) => ({
      ...prev,
      layout: { ...prev.layout, root: update(prev.layout.root) },
    }));
    persist(get());
  },

  patchTab: (tabId, patch) => {
    const state = get();
    const owner = findLeafContainingTab(state.layout.root, tabId);
    if (!owner) return;
    set((prev) => ({
      ...prev,
      layout: {
        ...prev.layout,
        root: mapLeaf(prev.layout.root, owner.id, (l) => ({
          ...l,
          tabs: l.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
        })),
      },
    }));
    persist(get());
  },

  setTabKind: (tabId, kind) => {
    const state = get();
    const owner = findLeafContainingTab(state.layout.root, tabId);
    if (!owner) return;
    set((prev) => ({
      ...prev,
      layout: {
        ...prev.layout,
        root: mapLeaf(prev.layout.root, owner.id, (l) => ({
          ...l,
          tabs: l.tabs.map((t) =>
            t.id === tabId ? { ...t, kind, title: defaultTitle(kind) } : t,
          ),
        })),
      },
    }));
    persist(get());
  },
}));

function clampIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index > length) return length;
  return index;
}

function defaultTitle(kind: TabKind): string {
  switch (kind.type) {
    case "overview":
      return "Home";
    case "session":
      return kind.taskId ? "Session" : "New session";
    case "file":
      return kind.path.split("/").pop() ?? kind.path;
    case "diff":
      return "Diff";
    case "project-diff":
      return "Working changes";
    case "browser":
      return "Browser";
    case "cdp-browser":
      return "CDP Browser";
    case "settings":
      return "Settings";
    case "skills":
      return "Skills";
    case "gallery":
      return "Gallery";
  }
}

export function useLayoutSelector<T>(selector: (state: LayoutStore) => T): T {
  return useLayoutStore(useShallow(selector));
}
