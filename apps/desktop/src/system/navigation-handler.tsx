import { useEffect } from "react";

export function NavigationHandler() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
