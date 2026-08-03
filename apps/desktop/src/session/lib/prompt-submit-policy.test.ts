import { describe, expect, it } from "vitest";
import {
  type PromptKeystroke,
  shouldSubmitPrompt,
} from "./prompt-submit-policy";

const stroke = (over: Partial<PromptKeystroke> = {}): PromptKeystroke => ({
  key: "Enter",
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  keyCode: 13,
  ...over,
});

describe("prompt submit policy", () => {
  it("submits on a bare Return", () => {
    expect(shouldSubmitPrompt(stroke())).toBe(true);
  });

  it("submits on Cmd/Ctrl+Return so the old shortcut keeps working", () => {
    expect(shouldSubmitPrompt(stroke({ metaKey: true }))).toBe(true);
    expect(shouldSubmitPrompt(stroke({ ctrlKey: true }))).toBe(true);
  });

  it("inserts a newline on Shift+Return and Alt+Return", () => {
    expect(shouldSubmitPrompt(stroke({ shiftKey: true }))).toBe(false);
    expect(shouldSubmitPrompt(stroke({ altKey: true }))).toBe(false);
  });

  it("ignores keys other than Return", () => {
    expect(shouldSubmitPrompt(stroke({ key: "a" }))).toBe(false);
    expect(shouldSubmitPrompt(stroke({ key: "Escape" }))).toBe(false);
  });

  // The Return that confirms an IME conversion must never send the message.
  it("never submits the Return that confirms an IME conversion", () => {
    // Blink: keydown fires mid-composition with isComposing set.
    expect(shouldSubmitPrompt(stroke({ isComposing: true }))).toBe(false);
    // WebKit (the desktop app's webview): compositionend lands before the
    // confirming keydown, so isComposing is already false and only the
    // keyCode still marks the keystroke as the IME's.
    expect(shouldSubmitPrompt(stroke({ keyCode: 229 }))).toBe(false);
  });
});
