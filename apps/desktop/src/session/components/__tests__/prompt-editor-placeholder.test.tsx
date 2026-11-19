/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPromptEditorHandle,
  usePromptEditorStore,
} from "../../state/prompt-editor-store";
import { PromptEditor } from "../prompt-editor/prompt-editor";

/**
 * The placeholder sits under the editable text, so it must disappear the
 * moment the user starts typing. An IME composition (Japanese input) puts
 * unconfirmed text in the editor before any `input` event is guaranteed to
 * reach the store; the desktop app showed the placeholder and the marked text
 * overlapping.
 */
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PLACEHOLDER = "Research, write, or ship";
const SCOPE = "tab:placeholder";

let container: HTMLDivElement;
let root: Root;

function mount() {
  act(() => {
    root.render(
      <PromptEditor
        handle={getPromptEditorHandle(SCOPE)}
        placeholder={PLACEHOLDER}
        onSubmit={() => {}}
      />,
    );
  });
  const editor = container.querySelector<HTMLDivElement>('[role="textbox"]');
  if (!editor) throw new Error("editor not rendered");
  return editor;
}

const placeholderShown = () =>
  container.textContent?.includes(PLACEHOLDER) ?? false;

function dispatch(editor: HTMLElement, event: Event) {
  act(() => {
    editor.dispatchEvent(event);
  });
}

describe("PromptEditor placeholder", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    usePromptEditorStore.setState({ scopes: {} });
  });

  it("is shown while the editor is empty", () => {
    mount();
    expect(placeholderShown()).toBe(true);
  });

  it("hides as soon as an IME composition starts, before any input event", () => {
    const editor = mount();

    dispatch(
      editor,
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    editor.textContent = "あ";

    expect(placeholderShown()).toBe(false);
  });

  it("stays hidden after the composition is confirmed into text", () => {
    const editor = mount();

    dispatch(
      editor,
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    editor.textContent = "あああ";
    dispatch(editor, new CompositionEvent("compositionend", { bubbles: true }));

    expect(placeholderShown()).toBe(false);
    expect(getPromptEditorHandle(SCOPE).getText()).toBe("あああ");
  });

  it("returns when a composition is cancelled with nothing typed", () => {
    const editor = mount();

    dispatch(
      editor,
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    dispatch(editor, new CompositionEvent("compositionend", { bubbles: true }));

    expect(placeholderShown()).toBe(true);
  });
});
