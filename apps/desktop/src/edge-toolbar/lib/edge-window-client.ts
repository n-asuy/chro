import type { SessionNotificationTarget } from "@/settings/lib/notification-target";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The renderer's side of the edge window contract with the Tauri shell
 * (`src-tauri/src/windows/edge.rs` and `activation.rs`). Outside Tauri (the
 * browser dev build) the window calls are no-ops and "Open in chro" opens the
 * session route in a new tab.
 */

export function report(command: string, error: unknown): void {
  console.warn(`[edge-toolbar] ${command} failed`, error);
}

/** Create or close the edge window to match the `edge_toolbar` flag. */
export function setEdgeToolbarEnabled(enabled: boolean): void {
  if (!isTauri()) return;
  invoke("edge_toolbar_set_enabled", { enabled }).catch((error) =>
    report("edge_toolbar_set_enabled", error),
  );
}

/**
 * A surface that takes the pointer, in CSS pixels from the window's corner.
 * A region with an `id` is also reported while the pointer is over it.
 */
export interface EdgeHitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  id?: string;
}

/**
 * Tell the shell which parts of the window take the pointer; clicks pass
 * through the rest of the (fixed, transparent) window. List a named region
 * after the regions that contain it: the last match is the one reported.
 */
export function setEdgeHitRegions(regions: readonly EdgeHitRegion[]): void {
  if (!isTauri()) return;
  invoke("edge_toolbar_set_hit_regions", { regions }).catch((error) =>
    report("edge_toolbar_set_hit_regions", error),
  );
}

/** Where the pointer is: on a surface or not, and which named region. */
export interface EdgePointer {
  inside: boolean;
  id: string | null;
}

/**
 * Follow the pointer over the window's surfaces. The shell samples the
 * cursor, so this works while the app is inactive, when the web view gets no
 * mouse moves. Returns the unsubscribe function.
 */
export function onEdgePointer(
  handler: (pointer: EdgePointer) => void,
): () => void {
  if (!isTauri()) return onDomPointer(handler);
  return subscribe<EdgePointer>("edge-pointer", handler);
}

/** Listen to a shell event until the returned function is called. */
export function subscribe<T>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | null = null;
  let disposed = false;
  listen<T>(event, (message) => handler(message.payload))
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error) => report(`listen ${event}`, error));
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * An Option key gesture, read by the shell from the keyboard state while the
 * app is in the background (`src-tauri/src/windows/option_tap.rs`).
 */
export type OptionGesture = "summon" | "holdStart" | "holdEnd" | "send";

/** Follow the Option gestures. Returns the unsubscribe function. */
export function onOptionGesture(
  handler: (gesture: OptionGesture) => void,
): () => void {
  return subscribe<OptionGesture>("edge-option", handler);
}

/**
 * Whether the toolbar steps aside: chro's own window is in front (see
 * `src-tauri/src/windows/edge_presence.rs`). Follows the changes; the
 * current state is read once on load.
 */
export function onEdgePresence(handler: (hidden: boolean) => void): () => void {
  if (!isTauri()) return () => {};
  invoke<boolean>("edge_presence")
    .then(handler)
    .catch((error) => report("edge_presence", error));
  return subscribe<{ hidden: boolean }>("edge-presence", ({ hidden }) =>
    handler(hidden),
  );
}

/** Dock the window against the left or right screen edge. */
export async function setEdgeSide(side: "left" | "right"): Promise<void> {
  if (!isTauri()) return;
  await invoke("edge_toolbar_set_side", { side }).catch((error) =>
    report("edge_toolbar_set_side", error),
  );
}

/** A view of the app window the "…" menu opens. */
export type AppView = "settings" | "feedback";

/** Show and focus the app window on one of its views. */
export function openAppView(view: AppView): void {
  if (!isTauri()) return;
  invoke("open_app_view", { view }).catch((error) =>
    report("open_app_view", error),
  );
}

/** Take keyboard focus, so J/K and Esc reach an open panel. */
export function focusEdgeWindow(): void {
  if (!isTauri()) return;
  getCurrentWindow()
    .setFocus()
    .catch((error) => report("setFocus", error));
}

/** Show and focus the app window on this session. */
export function openSessionInApp(target: SessionNotificationTarget): void {
  if (!isTauri()) {
    window.open(
      `/projects/${encodeURIComponent(target.projectId)}/session/${encodeURIComponent(target.taskId)}`,
      "_blank",
    );
    return;
  }
  invoke("open_session_in_app", { target }).catch((error) =>
    report("open_session_in_app", error),
  );
}

/**
 * Outside the shell (the browser dev build) the page sees the pointer itself;
 * it is reported the same way: `data-edge-hit` surfaces and the innermost
 * `data-edge-hover` region under it.
 */
function onDomPointer(handler: (pointer: EdgePointer) => void): () => void {
  let last = "";
  const move = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const pointer: EdgePointer = {
      inside: Boolean(target?.closest("[data-edge-hit]")),
      id:
        target?.closest<HTMLElement>("[data-edge-hover]")?.dataset.edgeHover ??
        null,
    };
    const key = `${pointer.inside}:${pointer.id}`;
    if (key === last) return;
    last = key;
    handler(pointer);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerover", move);
  return () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerover", move);
  };
}
