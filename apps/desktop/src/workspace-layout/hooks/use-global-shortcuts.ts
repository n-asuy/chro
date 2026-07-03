import { useEffect } from "react";
import { useCommandPaletteStore } from "../state/command-palette-store";
import { useRightDockStore } from "../state/right-dock-store";
import { useNewChat } from "./use-new-chat";

/**
 * Global ⌘-shortcut commands handled at the shell level:
 * - `palette`     — session-search command palette (⌘K / ⌘P)
 * - `file-search` — right-dock file search panel (⌘⇧F)
 * - `new-chat`    — open a new general-purpose chat (⌘N)
 */
export type GlobalShortcutAction = "palette" | "file-search" | "new-chat";

type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key"
>;

/**
 * Classify a keydown into a global command, or `null` when it isn't one of
 * ours (so the caller leaves the event untouched). Ctrl stands in for ⌘ on
 * non-mac keyboards. Extracted as a pure function so the mapping is unit
 * testable without a DOM.
 *
 * - ⌘K / ⌘P → session-search command palette
 * - ⌘⇧F     → file-search dock panel
 * - ⌘N      → new chat
 */
export function matchGlobalShortcut(
  event: ShortcutKeyEvent,
): GlobalShortcutAction | null {
  const isMeta = event.metaKey || event.ctrlKey;
  if (!isMeta || event.altKey) return null;
  const key = event.key.toLowerCase();

  if (event.shiftKey) {
    return key === "f" ? "file-search" : null;
  }
  if (key === "k" || key === "p") return "palette";
  if (key === "n") return "new-chat";
  return null;
}

/**
 * Shell-level keyboard commands. ⌘K / ⌘P open the session-search palette, ⌘⇧F
 * focuses file search, and ⌘N opens a new chat. Session search and file search
 * are deliberately distinct surfaces bound to distinct shortcuts.
 */
export function useGlobalShortcuts() {
  const openPalette = useCommandPaletteStore((s) => s.openPalette);
  const focusSearchPanel = useRightDockStore((s) => s.focusSearchPanel);
  const newChat = useNewChat();

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const action = matchGlobalShortcut(event);
      if (!action) return;
      event.preventDefault();
      if (action === "palette") {
        openPalette();
      } else if (action === "file-search") {
        focusSearchPanel();
      } else {
        void newChat();
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [openPalette, focusSearchPanel, newChat]);
}
