import type { EdgePanel } from "../state/edge-toolbar-store";

/**
 * Sequencing for the edge toolbar's motion. The motion itself (durations,
 * delays, curves) lives in `edge-toolbar.css`; this decides which state each
 * surface is in, so the CSS transitions between them play.
 */

/** The toolbar's two resting shapes: the tab on the screen edge, or out. */
export type ToolbarSurface = "collapsed" | "expanded";

export function toolbarSurface(
  expanded: boolean,
  panel: EdgePanel,
): ToolbarSurface {
  return expanded || panel !== null ? "expanded" : "collapsed";
}

/**
 * What the panel frame shows. A closed panel stays mounted with `on` false
 * until its exit transition has played; the caller clears it afterwards
 * ({@link closedPresence}).
 */
export interface PanelPresence {
  shown: EdgePanel;
  on: boolean;
}

export const closedPresence: PanelPresence = { shown: null, on: false };

function samePanel(a: EdgePanel, b: EdgePanel): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "session" || b.kind === "session") {
    return (
      a.kind === "session" && b.kind === "session" && a.taskId === b.taskId
    );
  }
  return a.kind === b.kind;
}

/**
 * The frame's next state when the open panel becomes `panel`. Opening shows
 * at once; switching between panels swaps the content in place (one frame,
 * no exit); closing turns the frame off and keeps the last content mounted.
 * Returns `prev` itself when nothing changes.
 */
export function nextPresence(
  prev: PanelPresence,
  panel: EdgePanel,
): PanelPresence {
  if (panel === null) {
    return prev.on ? { shown: prev.shown, on: false } : prev;
  }
  if (prev.on && samePanel(prev.shown, panel)) return prev;
  return { shown: panel, on: true };
}

/**
 * Whether the card's content crossfades in: when the pager moves from one
 * item to another, not when it first shows an item.
 */
export function cardEnters(
  previousId: string | null,
  nextId: string | null,
): boolean {
  return previousId !== null && nextId !== null && previousId !== nextId;
}

/**
 * Dots that grow into the capsule: those that joined after the first render.
 * `seen` is null before the first render.
 */
export function dotsToGrow(
  seen: ReadonlySet<string> | null,
  ids: readonly string[],
): string[] {
  if (seen === null) return [];
  return ids.filter((id) => !seen.has(id));
}

/** The Unread badge pops in on the expanded toolbar only. */
export function badgeShown(surface: ToolbarSurface, pending: boolean): boolean {
  return surface === "expanded" && pending;
}

/** Margin between a panel and the top or bottom of the window frame. */
const FRAME_INSET = 8;

/**
 * Where a panel's top sits: level with the toolbar's top (`anchor`), kept
 * inside the frame.
 */
export function panelTop({
  anchor,
  height,
  frameHeight,
}: {
  anchor: number;
  height: number;
  frameHeight: number;
}): number {
  const lowest = frameHeight - height - FRAME_INSET;
  return Math.max(FRAME_INSET, Math.min(lowest, anchor));
}

/**
 * A CSS time (`"320ms"`, `"1.3s"`) in milliseconds, for the few transitions
 * the renderer has to time itself; the values live in `edge-toolbar.css`.
 */
export function parseCssTime(value: string, fallback = 0): number {
  const match = /^\s*(\d+(?:\.\d+)?)(ms|s)\s*$/.exec(value);
  if (!match) return fallback;
  const amount = Number(match[1]);
  return match[2] === "s" ? amount * 1000 : amount;
}

/**
 * Longest a panel waits for its content before it opens anyway. Not a motion
 * value (the transition itself is the mock's); it only bounds how long a slow
 * server can hold the panel back.
 */
export const PANEL_CONTENT_WAIT_MS = 300;

/**
 * Whether the panel frame is on screen. It opens once its off style is
 * committed (so the transition plays from it) and its content has laid out
 * the data it shows, so the first visible frame is never an empty panel; a
 * content that is slow to load opens after {@link PANEL_CONTENT_WAIT_MS}.
 */
export function panelOnScreen({
  open,
  mounted,
  contentReady,
  waitedOut,
}: {
  open: boolean;
  mounted: boolean;
  contentReady: boolean;
  waitedOut: boolean;
}): boolean {
  return open && mounted && (contentReady || waitedOut);
}

/**
 * What Option pressed twice does (the mock's summon from the keyboard): it
 * closes Unread when Unread is open; otherwise it opens Unread when something
 * needs the user. With nothing needing the user it toggles the session list
 * (the mock starts talking there; chro has no voice).
 */
export function keyboardSummon(
  panel: EdgePanel,
  needsYou: boolean,
): "unread" | "list" | "close" {
  if (panel?.kind === "unread") return "close";
  if (needsYou) return "unread";
  return panel?.kind === "list" ? "close" : "list";
}
