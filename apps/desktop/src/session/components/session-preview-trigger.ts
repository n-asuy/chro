import { createContext, useCallback, useContext, useRef } from "react";
import type { StoredTask } from "../types";

/**
 * Where the preview panel opens relative to what was hovered: beside a session
 * row in a list, or below a session reference inside running text, where
 * opening beside it would cover the sentence being read.
 */
export type PreviewPlacement = "side" | "below";

export interface PreviewController {
  notifyEnter: (
    task: StoredTask,
    el: HTMLElement,
    placement: PreviewPlacement,
  ) => void;
  notifyLeave: () => void;
  notifyDismiss: () => void;
}

/** Null outside a `SessionPreviewProvider`, and inside the preview panel
 * itself, where hovering a reference must not move the panel out from under
 * the pointer. */
export const PreviewContext = createContext<PreviewController | null>(null);

/**
 * Hover trigger for one session anchor (a list row or an inline reference).
 * Attach `setAnchor` to the element and spread `hoverProps`; the shared panel
 * (rendered once by `SessionPreviewProvider`) handles display and slides
 * between anchors.
 */
export function useSessionPreviewTrigger(
  task: StoredTask,
  placement: PreviewPlacement = "side",
): {
  setAnchor: (el: HTMLElement | null) => void;
  hoverProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onPointerDown: () => void;
  };
} {
  const controller = useContext(PreviewContext);
  const elRef = useRef<HTMLElement | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;

  const setAnchor = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  const onPointerEnter = useCallback(() => {
    if (elRef.current) {
      controller?.notifyEnter(taskRef.current, elRef.current, placement);
    }
  }, [controller, placement]);
  const onPointerLeave = useCallback(() => {
    controller?.notifyLeave();
  }, [controller]);
  const onPointerDown = useCallback(() => {
    controller?.notifyDismiss();
  }, [controller]);

  return {
    setAnchor,
    hoverProps: { onPointerEnter, onPointerLeave, onPointerDown },
  };
}
