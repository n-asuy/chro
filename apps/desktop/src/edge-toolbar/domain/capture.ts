import type { PickedRect } from "../lib/edge-input-client";

/**
 * Point at it (the mock's region picker): drag out a region of the screen,
 * then say what should happen with it. These are the capture window's states
 * and the moves between them.
 */

/** A drag shorter than this either way is a click, not a region. */
export const MIN_PICK = 8;

export type CaptureState =
  | { phase: "picking"; dragging: PickedRect | null }
  | { phase: "asking"; rect: PickedRect; text: string }
  | { phase: "sending"; rect: PickedRect; text: string };

export const CAPTURE_START: CaptureState = { phase: "picking", dragging: null };

/** The rectangle between two corners, in either order. */
export function rectBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
): PickedRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** The drag so far. */
export function drag(state: CaptureState, rect: PickedRect): CaptureState {
  return state.phase === "picking"
    ? { phase: "picking", dragging: rect }
    : state;
}

/** The drag ended: ask about the region, or cancel when it was only a click. */
export function finishPick(
  state: CaptureState,
  rect: PickedRect,
): CaptureState | "cancel" {
  if (state.phase !== "picking") return state;
  if (rect.width < MIN_PICK || rect.height < MIN_PICK) return "cancel";
  return { phase: "asking", rect, text: "" };
}

/** What was typed or said about the region. */
export function setAsk(state: CaptureState, text: string): CaptureState {
  return state.phase === "asking" ? { ...state, text } : state;
}

/** Send: only with something said about the region. */
export function sendAsk(state: CaptureState): CaptureState | null {
  if (state.phase !== "asking" || !state.text.trim()) return null;
  return { ...state, phase: "sending" };
}

/** A send failed: back to asking, with the text kept. */
export function sendFailed(state: CaptureState): CaptureState {
  return state.phase === "sending" ? { ...state, phase: "asking" } : state;
}

/**
 * Where the ask pill goes: centred under the region, 14 px below it, kept
 * inside the screen (the mock's placement).
 */
export function askPlacement(
  rect: PickedRect,
  screen: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: Math.min(
      Math.max(12, rect.x + rect.width / 2 - 165),
      screen.width - 342,
    ),
    top: Math.min(rect.y + rect.height + 14, screen.height - 90),
  };
}
