import { selectActiveSessionMessages } from "@/session/utils/session-select-all";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

const SELECT_ALL_EVENT = "chro://select-all";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // @ts-expect-error - Tauri 2 marks its globals at startup.
    typeof window.__TAURI_INTERNALS__ !== "undefined"
  );
}

const hasMeaningfulText = (element: HTMLElement): boolean =>
  (element.textContent ?? "").replace(/\u200B/g, "").trim().length > 0;

const selectTextControl = (element: Element): boolean => {
  const control = element.closest("input,textarea");
  if (
    control instanceof HTMLInputElement ||
    control instanceof HTMLTextAreaElement
  ) {
    try {
      control.select();
      return true;
    } catch {
      return false;
    }
  }
  return false;
};

const selectEditable = (element: Element): boolean => {
  const editable = element.closest<HTMLElement>(
    "[contenteditable]:not([contenteditable='false']),[role='textbox']",
  );
  if (!editable || !hasMeaningfulText(editable)) return false;

  editable.focus({ preventScroll: true });

  try {
    if (document.execCommand("selectAll")) return true;
  } catch {
    // Fall back to a DOM range below.
  }

  const selection = editable.ownerDocument.defaultView?.getSelection();
  if (!selection) return false;

  const range = editable.ownerDocument.createRange();
  range.selectNodeContents(editable);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

const selectNativeEditable = (): boolean => {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof Element)) return false;

  return selectTextControl(activeElement) || selectEditable(activeElement);
};

const selectDocument = (): void => {
  try {
    if (document.execCommand("selectAll")) return;
  } catch {
    // Fall back to selecting body contents below.
  }

  const selection = window.getSelection();
  if (!selection || !document.body) return;

  const range = document.createRange();
  range.selectNodeContents(document.body);
  selection.removeAllRanges();
  selection.addRange(range);
};

export function useSelectAllMenuShortcut() {
  useEffect(() => {
    if (!isTauri()) return;

    const unlisten = listen(SELECT_ALL_EVENT, () => {
      if (selectNativeEditable()) return;
      if (selectActiveSessionMessages()) return;
      selectDocument();
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);
}
