import type { EditorState } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";

/**
 * Check if cursor position overlaps with a node range
 */
export function cursorInNode(
  cursorFrom: number | undefined,
  cursorTo: number | undefined,
  nodeFrom: number | undefined,
  nodeTo: number | undefined,
): boolean {
  const cf = cursorFrom ?? 0;
  const ct = cursorTo ?? 0;
  const nf = nodeFrom ?? 0;
  const nt = nodeTo ?? 0;
  return (
    (cf >= nf && cf <= nt) || (ct >= nf && ct <= nt) || (cf <= nf && ct >= nt)
  );
}

/**
 * Check if cursor selection completely covers a node
 */
export function cursorSelectionCoveredNode(
  cursorFrom: number | undefined,
  cursorTo: number | undefined,
  nodeFrom: number | undefined,
  nodeTo: number | undefined,
): boolean {
  const cf = cursorFrom ?? 0;
  const ct = cursorTo ?? 0;
  const nf = nodeFrom ?? 0;
  const nt = nodeTo ?? 0;
  return cf <= nf && ct >= nt;
}

/**
 * Extract cursor and node positions from state
 */
export function toCursorNodePositions(
  state: EditorState,
  node?: SyntaxNodeRef,
) {
  const [cursor] = state.selection.ranges;
  return {
    cursorFrom: cursor?.from ?? 0,
    cursorTo: cursor?.to ?? 0,
    nodeFrom: node?.from ?? 0,
    nodeTo: node?.to ?? 0,
  };
}

/**
 * Check if a node range is active (cursor is within or overlaps)
 */
export function isNodeRangeActive(
  state: EditorState,
  nodeFrom: number,
  nodeTo: number,
): boolean {
  const cursor = state.selection.main;
  if (cursor.empty) {
    return cursor.from >= nodeFrom && cursor.from <= nodeTo;
  }
  return Math.max(nodeFrom, cursor.from) < Math.min(nodeTo, cursor.to);
}

/**
 * Check if cursor is within a specific range
 */
export function isCursorInRange(
  state: EditorState,
  range: [from: number, to: number],
): boolean {
  return state.selection.ranges.some((r) => {
    const from = Math.min(r.from, r.to);
    const to = Math.max(r.from, r.to);
    return from >= range[0] && to <= range[1];
  });
}

