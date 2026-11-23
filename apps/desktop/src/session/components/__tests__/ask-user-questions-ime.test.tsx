/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AskUserAnswer, AskUserQuestions } from "../ask-user-questions";

/**
 * The free-form "Other" answer is typed in Japanese as often as not. The
 * Return that confirms an IME conversion must stay inside the IME; treating it
 * as a submit sent half-typed answers.
 */
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// jsdom ships no layout engine; the card only measures itself with these.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mount(
  onComplete: (answers: Record<string, AskUserAnswer>) => void,
  multiSelect = false,
) {
  act(() => {
    root.render(
      <AskUserQuestions
        questions={[
          {
            id: "q",
            title: "Which approach?",
            options: [{ title: "A" }, { title: "B" }],
            allowOther: true,
            multiSelect,
          },
        ]}
        onComplete={onComplete}
      />,
    );
  });
  const field = container.querySelector("textarea");
  if (!field) throw new Error("Other field not rendered");
  return field;
}

function type(field: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setValue?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressReturn(field: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    keyCode: 13,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    field.dispatchEvent(event);
  });
  return event;
}

describe("AskUserQuestions Other field with an IME", () => {
  it("submits the answer on a plain Return", () => {
    const onComplete = vi.fn();
    const field = mount(onComplete);
    type(field, "別案");
    pressReturn(field);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[0].q.otherText).toBe("別案");
  });

  // Blink: keydown arrives mid-composition with isComposing set.
  it("keeps a Return the IME owns while composing", () => {
    const onComplete = vi.fn();
    const field = mount(onComplete);
    type(field, "べつあん");
    const event = pressReturn(field, { isComposing: true, keyCode: 229 });
    expect(onComplete).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  // WebKit (the desktop webview): compositionend lands before the confirming
  // keydown, so only the legacy keyCode still marks it as the IME's.
  it("keeps the confirming Return WebKit reports after compositionend", () => {
    const onComplete = vi.fn();
    const field = mount(onComplete);
    type(field, "別案");
    const event = pressReturn(field, { keyCode: 229 });
    expect(onComplete).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not take a multi-select Continue from an IME Return", () => {
    const onComplete = vi.fn();
    const field = mount(onComplete, true);
    type(field, "別案");
    pressReturn(field, { metaKey: true, ctrlKey: true, keyCode: 229 });
    expect(onComplete).not.toHaveBeenCalled();
    pressReturn(field, { metaKey: true, ctrlKey: true });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
