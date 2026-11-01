import { describe, expect, it } from "vitest";
import {
  PREVIEW_ANNOTATION_LIMITS,
  PREVIEW_ANNOTATION_MESSAGE,
  annotateSyncMessage,
  parsePreviewAnnotationMessage,
} from "./preview-annotation";

const note = {
  selector: "main > button",
  element: 'button "Buy"',
  text: "Buy",
  rect: { x: 1.4, y: 2.6, width: 30, height: 12 },
  comment: "Bigger",
};

describe("parsePreviewAnnotationMessage", () => {
  it("reads a note together with the viewport it was made in", () => {
    expect(
      parsePreviewAnnotationMessage({
        type: PREVIEW_ANNOTATION_MESSAGE.add,
        note,
        viewport: { width: 1280, height: 800 },
      }),
    ).toEqual({
      kind: "add",
      note: { ...note, rect: { x: 1, y: 3, width: 30, height: 12 } },
      viewport: { width: 1280, height: 800 },
    });
  });

  it("recognises the lifecycle messages", () => {
    expect(
      parsePreviewAnnotationMessage({ type: PREVIEW_ANNOTATION_MESSAGE.ready }),
    ).toEqual({ kind: "ready" });
    expect(
      parsePreviewAnnotationMessage({ type: PREVIEW_ANNOTATION_MESSAGE.exit }),
    ).toEqual({ kind: "exit" });
  });

  it("rejects notes without a comment or with a malformed shape", () => {
    const add = (value: unknown) =>
      parsePreviewAnnotationMessage({
        type: PREVIEW_ANNOTATION_MESSAGE.add,
        note: value,
        viewport: { width: 1, height: 1 },
      });
    expect(add({ ...note, comment: "   " })).toBeNull();
    expect(add({ ...note, rect: { x: "1" } })).toBeNull();
    expect(add(null)).toBeNull();
  });

  it("clips page-controlled strings to bounded lengths", () => {
    const long = "x".repeat(PREVIEW_ANNOTATION_LIMITS.comment + 50);
    const parsed = parsePreviewAnnotationMessage({
      type: PREVIEW_ANNOTATION_MESSAGE.add,
      note: { ...note, comment: long, text: long, selector: long },
      viewport: null,
    });
    expect(parsed?.kind).toBe("add");
    if (parsed?.kind !== "add") return;
    expect(parsed.note.comment).toHaveLength(PREVIEW_ANNOTATION_LIMITS.comment);
    expect(parsed.note.text).toHaveLength(PREVIEW_ANNOTATION_LIMITS.text);
    expect(parsed.note.selector).toHaveLength(
      PREVIEW_ANNOTATION_LIMITS.selector,
    );
    expect(parsed.viewport).toBeNull();
  });

  it("ignores messages that belong to the page or to the link bridge", () => {
    expect(parsePreviewAnnotationMessage({ type: "chro:preview-link" })).toBe(
      null,
    );
    expect(parsePreviewAnnotationMessage("hello")).toBeNull();
  });
});

describe("annotateSyncMessage", () => {
  it("tells the frame its mode, the pins to draw and the labels to use", () => {
    expect(
      annotateSyncMessage(true, [note], {
        placeholder: "What?",
        add: "Add",
        cancel: "Cancel",
        hint: "hint",
      }),
    ).toEqual({
      type: PREVIEW_ANNOTATION_MESSAGE.sync,
      active: true,
      pins: [{ selector: "main > button" }],
      labels: { placeholder: "What?", add: "Add", cancel: "Cancel", hint: "hint" },
    });
  });
});
