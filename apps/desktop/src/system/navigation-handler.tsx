import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useHistorySpanStore } from "./history-span";

export function NavigationHandler() {
  const router = useRouter();

  useEffect(() => {
    const { record } = useHistorySpanStore.getState();
    // Seed with the entry the app (re)loaded on; it may sit deep in the stack.
    record("REPLACE", router.history.location.state.__TSR_index);
    return router.history.subscribe(({ location, action }) => {
      record(action.type, location.state.__TSR_index);
    });
  }, [router]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // A focused editor's own binding wins (⌘[ outdents a list item).
      if (e.defaultPrevented) return;
      const isMac = navigator.platform.startsWith("Mac");

      if (isMac && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        if (e.key === "[") {
          e.preventDefault();
          window.history.back();
          return;
        }
        if (e.key === "]") {
          e.preventDefault();
          window.history.forward();
          return;
        }
      }

      if (!isMac && e.altKey && !e.metaKey && !e.shiftKey && !e.ctrlKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          window.history.back();
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          window.history.forward();
          return;
        }
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      // Mouse button 3 = back, 4 = forward
      if (e.button === 3) {
        e.preventDefault();
        window.history.back();
      } else if (e.button === 4) {
        e.preventDefault();
        window.history.forward();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return null;
}
