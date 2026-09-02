import { describe, expect, it } from "vitest";
import {
  type PromptKeystroke,
  shouldSubmitPrompt,
} from "./prompt-submit-policy";

/** A Cmd+Return, i.e. the submit chord. Override to build the other cases. */
const stroke = (over: Partial<PromptKeystroke> = {}): PromptKeystroke => ({
  key: "Enter",
  shiftKey: false,
  altKey: false,
  metaKey: true,
  ctrlKey: false,
  isComposing: false,
  keyCode: 13,
  ...over,
});

describe("prompt submit policy", () => {
  it("submits on Cmd+Return and on Ctrl+Return", () => {
    expect(shouldSubmitPrompt(stroke())).toBe(true);
    expect(shouldSubmitPrompt(stroke({ metaKey: false, ctrlKey: true }))).toBe(
      true,
    );
  });

  // The composer holds multi-line prompts, so an unmodified Return is a
  // newline — not a send.
  it("inserts a newline on a bare Return", () => {
    expect(shouldSubmitPrompt(stroke({ metaKey: false }))).toBe(false);
  });

  it("inserts a newline when Shift or Alt joins the chord", () => {
    expect(shouldSubmitPrompt(stroke({ shiftKey: true }))).toBe(false);
    expect(shouldSubmitPrompt(stroke({ altKey: true }))).toBe(false);
  });

  it("ignores keys other than Return", () => {
    expect(shouldSubmitPrompt(stroke({ key: "a" }))).toBe(false);
    expect(shouldSubmitPrompt(stroke({ key: "Escape" }))).toBe(false);
  });

  // Sending mid-conversion would submit text the IME has not committed yet.
  it("never submits a Return the IME still owns", () => {
    // Blink: keydown fires mid-composition with isComposing set.
    expect(shouldSubmitPrompt(stroke({ isComposing: true }))).toBe(false);
    // WebKit (the desktop app's webview): compositionend lands before the
    // confirming keydown, so isComposing is already false and only the
    // keyCode still marks the keystroke as the IME's.
    expect(shouldSubmitPrompt(stroke({ keyCode: 229 }))).toBe(false);
  });
});
