/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PageAnnotations } from "../types/context";
import {
  getPromptEditorHandle,
  parseFromDOM,
  usePromptEditorStore,
} from "./prompt-editor-store";

const PAGE: PageAnnotations = {
  path: "site/pricing.html",
  viewport: { width: 1280, height: 800 },
  notes: [
    {
      selector: "section.plans > button",
      element: 'button "Start trial"',
      text: "Start trial",
      rect: { x: 10, y: 20, width: 170, height: 34 },
      comment: "Primary color",
    },
    {
      selector: "h1",
      element: "h1",
      rect: { x: 0, y: 0, width: 600, height: 40 },
      comment: "Shorter",
    },
  ],
};

const textPrompt = (content: string) => [
  { type: "text" as const, content, start: 0, end: content.length },
];

describe("addAnnotationsPart", () => {
  afterEach(() => {
    usePromptEditorStore.setState({ scopes: {} });
  });

  it("does not add a separator when the draft already ends in whitespace", () => {
    const handle = getPromptEditorHandle("tab:spaced");
    usePromptEditorStore
      .getState()
      .setPrompt(handle.scopeId, textPrompt("please\n"));

    handle.addAnnotationsPart(PAGE);

    expect(handle.getText()).toBe("please\n ");
  });

  it("appends to a composer that is not mounted, keeping its draft", () => {
    const handle = getPromptEditorHandle("tab:unmounted");
    usePromptEditorStore
      .getState()
      .setPrompt(handle.scopeId, textPrompt("please"));

    handle.addAnnotationsPart(PAGE);

    // Separated from the existing words on both sides.
    expect(handle.getText()).toBe("please  ");
    expect(handle.getContextEntries()).toEqual([
      { kind: "annotations", ...PAGE },
    ]);
    expect(handle.isEmpty()).toBe(false);
  });

  it("renders a pill into a mounted composer that parses back to the same prompt", () => {
    const handle = getPromptEditorHandle("tab:mounted");
    const editor = document.createElement("div");
    handle.editorRef.current = editor;
    usePromptEditorStore
      .getState()
      .setPrompt(handle.scopeId, textPrompt("Polish this"));

    handle.addAnnotationsPart(PAGE);

    const pill = editor.querySelector<HTMLElement>("[data-type=annotations]");
    expect(pill?.textContent).toBe("pricing.html · 2 notes");
    expect(editor.textContent).toBe("Polish this pricing.html · 2 notes ");
    expect(parseFromDOM(editor)).toEqual(
      usePromptEditorStore.getState().scopes[handle.scopeId].prompt,
    );
    handle.editorRef.current = null;
  });
});
