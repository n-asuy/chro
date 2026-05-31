import type {
  PaneLayout,
  PaneLeaf,
  PaneNode,
  PaneSplit,
  SplitDirection,
} from "../types";

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

export function createLeaf(
  init: Partial<Omit<PaneLeaf, "type" | "id">> & { id?: string } = {},
): PaneLeaf {
  return {
    type: "leaf",
    id: init.id ?? nextId("leaf"),
    tabs: init.tabs ?? [],
    activeTabId: init.activeTabId ?? null,
  };
}

export function createSplit(
  direction: SplitDirection,
  first: PaneNode,
  second: PaneNode,
  sizes: [number, number] = [50, 50],
  id?: string,
): PaneSplit {
  return {
    type: "split",
    id: id ?? nextId("split"),
    direction,
    sizes,
    children: [first, second],
  };
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id);
}

export function firstLeaf(node: PaneNode): PaneLeaf {
  if (node.type === "leaf") return node;
  return firstLeaf(node.children[0]);
}

export function allLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === "leaf") return [node];
  return [...allLeaves(node.children[0]), ...allLeaves(node.children[1])];
}

export function findLeafContainingTab(
  node: PaneNode,
  tabId: string,
): PaneLeaf | null {
  if (node.type === "leaf") {
    return node.tabs.some((t) => t.id === tabId) ? node : null;
  }
  return (
    findLeafContainingTab(node.children[0], tabId) ??
    findLeafContainingTab(node.children[1], tabId)
  );
}

/**
 * Replace a leaf node anywhere in the tree, returning a new root. If the
 * replacement is a split that itself collapses to its sole child (because
 * the leaf was emptied and removed), the parent collapses up.
 */
export function replaceLeaf(
  node: PaneNode,
  targetId: string,
  replacement: PaneNode | null,
): PaneNode | null {
  if (node.type === "leaf") {
    return node.id === targetId ? replacement : node;
  }
  const left = replaceLeaf(node.children[0], targetId, replacement);
  const right = replaceLeaf(node.children[1], targetId, replacement);
  if (left === null && right === null) return null;
  if (left === null) return right;
  if (right === null) return left;
  if (left === node.children[0] && right === node.children[1]) return node;
  return {
    ...node,
    children: [left, right],
  };
}

export function mapLeaf(
  node: PaneNode,
  targetId: string,
  fn: (leaf: PaneLeaf) => PaneLeaf,
): PaneNode {
  if (node.type === "leaf") return node.id === targetId ? fn(node) : node;
  const left = mapLeaf(node.children[0], targetId, fn);
  const right = mapLeaf(node.children[1], targetId, fn);
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

/**
 * Split a leaf in the given direction, placing a fresh empty leaf on the
 * specified side. Returns the new root and the id of the freshly created leaf.
 */
export function splitLeaf(
  root: PaneNode,
  targetLeafId: string,
  direction: SplitDirection,
  side: "before" | "after",
): { root: PaneNode; newLeafId: string } | null {
  const target = findLeaf(root, targetLeafId);
  if (!target) return null;
  const fresh = createLeaf();
  const [first, second] =
    side === "before" ? [fresh, target] : [target, fresh];
  const split = createSplit(direction, first, second);
  const next = replaceLeaf(root, targetLeafId, split);
  if (!next) return null;
  return { root: next, newLeafId: fresh.id };
}

export function createInitialLayout(): PaneLayout {
  const leaf = createLeaf();
  return { root: leaf, focusedPaneId: leaf.id };
}

export function focusableLeafIdAfterRemoval(
  root: PaneNode,
  removedLeafId: string,
  previousFocus: string,
): string {
  if (previousFocus !== removedLeafId) return previousFocus;
  return firstLeaf(root).id;
}
