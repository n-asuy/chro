import type { DragEvent as ReactDragEvent } from "react";
import { useCallback, useEffect, useState } from "react";

/** True when the drag payload carries OS files (vs. text/HTML/internal drags). */
const carriesFiles = (dataTransfer: DataTransfer | null): boolean =>
  dataTransfer != null && Array.from(dataTransfer.types).includes("Files");

export interface ComposerFileDrag {
  /** Whether files are currently being dragged over the composer. */
  isDragActive: boolean;
  /** Keep the container a valid drop target; highlight only for file drags. */
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  /** Clear the highlight once the pointer leaves the composer entirely. */
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  /** Imperatively clear the highlight (e.g. right after a handled drop). */
  endDrag: () => void;
}

/**
 * Tracks whether files are being dragged over the message composer so the
 * frame can highlight and the placeholder can invite a drop.
 *
 * Scoped to native file drags: internal file-tree drags are mouse-based and
 * surface their own affordance elsewhere. `onDragOver` still prevents default
 * unconditionally so the container keeps accepting every payload it drops
 * (files and session cards); only the highlight is file-scoped.
 */
export function useComposerFileDrag(): ComposerFileDrag {
  const [isDragActive, setIsDragActive] = useState(false);

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!carriesFiles(event.dataTransfer)) return;
    event.dataTransfer.dropEffect = "copy";
    setIsDragActive(true);
  }, []);

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // A leave into a descendant still counts as "over"; only clear when the
    // pointer exits the composer entirely. Prevents flicker over children.
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setIsDragActive(false);
  }, []);

  const endDrag = useCallback(() => setIsDragActive(false), []);

  // Safety net: clear the highlight whenever any drag ends anywhere (a drop
  // handled by the window-level listener, or a cancelled drag), so the frame
  // never stays lit after the gesture is over.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reset = () => setIsDragActive(false);
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  return { isDragActive, onDragOver, onDragLeave, endDrag };
}
