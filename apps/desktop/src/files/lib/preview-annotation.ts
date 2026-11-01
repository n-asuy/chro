/**
 * Annotation messages exchanged with the HTML preview frame.
 *
 * The server appends an overlay script to the previewed document (see
 * `preview_annotation_overlay.js` in the server crate). While annotation mode
 * is on, the overlay outlines the element under the pointer, asks for a
 * comment on click and reports the result here. The app owns the list of
 * notes; the frame only draws pins for the selectors it is told about, so a
 * reload of the document (save, refresh) keeps every note.
 *
 * The previewed document is arbitrary project HTML and can post the same
 * shapes itself. That is acceptable because a reported note only lands in the
 * tray, where the user reads it before choosing to send it, but it is why every
 * field is validated and clipped here before use.
 */

import {
  type AnnotationRect,
  type PageAnnotation,
  isPageAnnotation,
} from "@/session/types/context";

/** Message types. Must match the constants in the overlay script. */
export const PREVIEW_ANNOTATION_MESSAGE = {
  /** Frame → app: the overlay loaded and wants the current mode and pins. */
  ready: "chro:annotate-ready",
  /** Frame → app: the user committed a comment on an element. */
  add: "chro:annotate-add",
  /** Frame → app: the user pressed Escape with nothing left to cancel. */
  exit: "chro:annotate-exit",
  /** App → frame: mode, pins to draw and localized labels. */
  sync: "chro:annotate-sync",
} as const;

/** Upper bounds for page-controlled strings carried into a prompt. */
export const PREVIEW_ANNOTATION_LIMITS = {
  selector: 512,
  element: 160,
  text: 240,
  comment: 4000,
} as const;

export type AnnotationViewport = { width: number; height: number };

export type PreviewAnnotationMessage =
  | { kind: "ready" }
  | { kind: "exit" }
  | { kind: "add"; note: PageAnnotation; viewport: AnnotationViewport | null };

export type AnnotationOverlayLabels = {
  placeholder: string;
  add: string;
  cancel: string;
  hint: string;
};

export type AnnotateSyncMessage = {
  type: typeof PREVIEW_ANNOTATION_MESSAGE.sync;
  active: boolean;
  pins: { selector: string }[];
  labels: AnnotationOverlayLabels;
};

const roundRect = (rect: AnnotationRect): AnnotationRect => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});

const parseViewport = (value: unknown): AnnotationViewport | null => {
  if (!value || typeof value !== "object") return null;
  const { width, height } = value as Record<string, unknown>;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!(width > 0 && height > 0)) return null;
  return { width: Math.round(width), height: Math.round(height) };
};

const clip = (value: string, limit: number): string => value.slice(0, limit);

const parseNote = (value: unknown): PageAnnotation | null => {
  if (!isPageAnnotation(value)) return null;
  const comment = clip(value.comment.trim(), PREVIEW_ANNOTATION_LIMITS.comment);
  if (!comment) return null;
  const note: PageAnnotation = {
    selector: clip(value.selector, PREVIEW_ANNOTATION_LIMITS.selector),
    element: clip(value.element, PREVIEW_ANNOTATION_LIMITS.element),
    rect: roundRect(value.rect),
    comment,
  };
  const text = value.text?.trim();
  if (text) note.text = clip(text, PREVIEW_ANNOTATION_LIMITS.text);
  return note;
};

/** Validate a `postMessage` payload from the preview frame. */
export const parsePreviewAnnotationMessage = (
  data: unknown,
): PreviewAnnotationMessage | null => {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Record<string, unknown>;
  switch (candidate.type) {
    case PREVIEW_ANNOTATION_MESSAGE.ready:
      return { kind: "ready" };
    case PREVIEW_ANNOTATION_MESSAGE.exit:
      return { kind: "exit" };
    case PREVIEW_ANNOTATION_MESSAGE.add: {
      const note = parseNote(candidate.note);
      if (!note) return null;
      return { kind: "add", note, viewport: parseViewport(candidate.viewport) };
    }
    default:
      return null;
  }
};

/** The state the frame should mirror. */
export const annotateSyncMessage = (
  active: boolean,
  notes: readonly PageAnnotation[],
  labels: AnnotationOverlayLabels,
): AnnotateSyncMessage => ({
  type: PREVIEW_ANNOTATION_MESSAGE.sync,
  active,
  pins: notes.map((note) => ({ selector: note.selector })),
  labels,
});
