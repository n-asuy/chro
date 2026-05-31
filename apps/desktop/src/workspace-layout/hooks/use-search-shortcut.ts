import { useEffect } from "react";
import { useRightDockStore } from "../state/right-dock-store";

/**
 * ⌘K / ⌘P / ⌘O — focus the right-dock Search panel.
 *
 * Replaces the former Headless UI command palette modal: instead of opening
 * a centered dialog, the shortcut activates the Search dock panel and
 * focuses its input. The previously-typed query is preserved across opens
 * (SearchDockPanel owns its own local state).
 */
export function useSearchShortcut() {
  const focusSearchPanel = useRightDockStore((s) => s.focusSearchPanel);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const isMeta = event.metaKey || event.ctrlKey;
      if (!isMeta || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key !== "k" && key !== "p" && key !== "o") return;
      event.preventDefault();
      focusSearchPanel();
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [focusSearchPanel]);
}
