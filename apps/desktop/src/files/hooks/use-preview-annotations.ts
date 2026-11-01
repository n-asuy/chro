import { useLanguage } from "@/i18n";
import type { PageAnnotation, PageAnnotations } from "@/session/types/context";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AnnotationOverlayLabels,
  type AnnotationViewport,
  annotateSyncMessage,
  parsePreviewAnnotationMessage,
} from "../lib/preview-annotation";

type Options = {
  frameRef: RefObject<HTMLIFrameElement | null>;
  /** Origin the preview document is served from; messages go nowhere else. */
  frameOrigin: string | null;
  /** Path of the previewed document. A different document starts over. */
  documentPath: string | null;
  /** False while the preview is not shown (raw source view). */
  enabled: boolean;
};

export type PreviewAnnotations = {
  active: boolean;
  setActive: (active: boolean) => void;
  notes: readonly PageAnnotation[];
  removeNote: (index: number) => void;
  clear: () => void;
  /** Snapshot of the pass, or null when there is nothing to send. */
  page: PageAnnotations | null;
};

/**
 * Annotation state of one HTML preview. The notes live here, not in the
 * frame: the overlay is told which selectors to pin every time it loads, so
 * saving or refreshing the document keeps the pass intact.
 */
export function usePreviewAnnotations({
  frameRef,
  frameOrigin,
  documentPath,
  enabled,
}: Options): PreviewAnnotations {
  const { t } = useLanguage();
  const [active, setActive] = useState(false);
  const [notes, setNotes] = useState<PageAnnotation[]>([]);
  const [viewport, setViewport] = useState<AnnotationViewport | null>(null);

  // A different document starts a new pass.
  useEffect(() => {
    setActive(false);
    setNotes([]);
    setViewport(null);
  }, [documentPath]);

  const labels = useMemo<AnnotationOverlayLabels>(
    () => ({
      placeholder: t("annotationsOverlayPlaceholder"),
      add: t("annotationsOverlayAdd"),
      cancel: t("annotationsOverlayCancel"),
      hint: t("annotationsOverlayHint"),
    }),
    [t],
  );

  const syncMessage = useMemo(
    () => annotateSyncMessage(active && enabled, notes, labels),
    [active, enabled, notes, labels],
  );
  const syncMessageRef = useRef(syncMessage);
  syncMessageRef.current = syncMessage;

  const postSync = useCallback(() => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow || !frameOrigin) return;
    frameWindow.postMessage(syncMessageRef.current, frameOrigin);
  }, [frameRef, frameOrigin]);

  // Push every state change to the frame.
  useEffect(() => {
    postSync();
  }, [postSync, syncMessage]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const message = parsePreviewAnnotationMessage(event.data);
      if (!message) return;
      switch (message.kind) {
        case "ready":
          // A (re)loaded document starts blank; give it the current pass.
          postSync();
          return;
        case "exit":
          setActive(false);
          return;
        case "add":
          setNotes((current) => [...current, message.note]);
          if (message.viewport) setViewport(message.viewport);
          return;
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameRef, postSync]);

  // Escape leaves the mode from the app side too. The frame handles it when
  // it has focus; after a click on the toolbar or tray the app has it.
  const isActive = active && enabled;
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) {
        return;
      }
      setActive(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive]);

  const removeNote = useCallback((index: number) => {
    setNotes((current) => current.filter((_, i) => i !== index));
  }, []);
  const clear = useCallback(() => setNotes([]), []);

  const page = useMemo<PageAnnotations | null>(
    () =>
      documentPath && notes.length > 0
        ? { path: documentPath, viewport, notes }
        : null,
    [documentPath, viewport, notes],
  );

  return { active: isActive, setActive, notes, removeNote, clear, page };
}
