import { useEffect, useRef } from "react";
import {
  WORKSPACE_LEADER_KEY,
  WORKSPACE_LEADER_SHORTCUTS,
} from "../lib/keyboard-shortcuts";
import { useLayoutStore } from "../state/layout-store";

const LEADER_TIMEOUT_MS = 1500;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Linear/GitHub-style leader-key shortcuts. `g` arms the leader; the next
 * keystroke (within {@link LEADER_TIMEOUT_MS}) routes to a tab kind:
 *
 * - `g s` → open the Sessions tab
 *
 * Used in place of `⌘1`/`⌘2` because Chrome reserves those for tab switching
 * and never delivers them to the page, making them useless in browser/CLI mode.
 */
export function useLeaderKeyShortcuts() {
  const openTab = useLayoutStore((s) => s.openTab);
  const leaderActive = useRef(false);
  const leaderTimer = useRef<number | null>(null);

  useEffect(() => {
    const clearLeader = () => {
      leaderActive.current = false;
      if (leaderTimer.current !== null) {
        window.clearTimeout(leaderTimer.current);
        leaderTimer.current = null;
      }
    };

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        if (leaderActive.current) clearLeader();
        return;
      }
      if (event.isComposing) return;
      if (isEditableTarget(event.target)) {
        if (leaderActive.current) clearLeader();
        return;
      }

      const key = event.key;

      if (leaderActive.current) {
        clearLeader();
        if (key === WORKSPACE_LEADER_SHORTCUTS.sessions.key) {
          event.preventDefault();
          openTab({ type: "session" });
          return;
        }
        return;
      }

      if (key === WORKSPACE_LEADER_KEY) {
        leaderActive.current = true;
        leaderTimer.current = window.setTimeout(clearLeader, LEADER_TIMEOUT_MS);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      clearLeader();
    };
  }, [openTab]);
}
