import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { findLeaf } from "../lib/pane-tree";
import { useLayoutStore } from "../state/layout-store";

/** Must match `menu::CLOSE_ACTIVE_TAB_EVENT` in the Tauri shell. */
const CLOSE_ACTIVE_TAB_EVENT = "chro://close-active-tab";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // @ts-expect-error — Tauri 2 marks its globals at startup
    typeof window.__TAURI_INTERNALS__ !== "undefined"
  );
}

/**
 * ⌘W — close the active tab of the focused pane.
 *
 * On macOS the application menu intercepts ⌘W before the keystroke reaches the
 * webview, so the Rust shell rebinds ⌘W to a "Close Tab" menu item that emits
 * `chro://close-active-tab` to the focused window. This hook performs the
 * actual close. (⇧⌘W still closes the whole window, handled natively.)
 */
export function useCloseTabShortcut() {
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen(CLOSE_ACTIVE_TAB_EVENT, () => {
      const state = useLayoutStore.getState();
      const leaf = findLeaf(state.layout.root, state.layout.focusedPaneId);
      const tabId = leaf?.activeTabId;
      if (tabId) state.closeTab(tabId);
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);
}
