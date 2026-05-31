import { afterEach, describe, expect, it } from "vitest";
import {
  getPromptEditorHandle,
  usePromptEditorStore,
} from "./prompt-editor-store";

const textPrompt = (content: string) => [
  { type: "text" as const, content, start: 0, end: content.length },
];

describe("prompt editor scope state", () => {
  afterEach(() => {
    usePromptEditorStore.setState({ scopes: {} });
  });

  it("keeps prompt text isolated by scope", () => {
    const first = getPromptEditorHandle("tab:first");
    const second = getPromptEditorHandle("tab:second");

    usePromptEditorStore
      .getState()
      .setPrompt(first.scopeId, textPrompt("first"));
    usePromptEditorStore
      .getState()
      .setPrompt(second.scopeId, textPrompt("second"));

    expect(first.getText()).toBe("first");
    expect(second.getText()).toBe("second");
  });

  it("clears only the selected scope", () => {
    const first = getPromptEditorHandle("tab:first");
    const second = getPromptEditorHandle("tab:second");

    usePromptEditorStore
      .getState()
      .setPrompt(first.scopeId, textPrompt("first"));
    usePromptEditorStore
      .getState()
      .setPrompt(second.scopeId, textPrompt("second"));

    first.clear();

    expect(first.getText()).toBe("");
    expect(second.getText()).toBe("second");
  });
});
