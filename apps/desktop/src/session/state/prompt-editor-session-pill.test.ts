/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getPromptEditorHandle,
  usePromptEditorStore,
} from "./prompt-editor-store";

const TASK_ID = "79d441b9-33b0-4533-9439-41a23f5ec8b0";

const mountEditor = (scopeId: string) => {
  const handle = getPromptEditorHandle(scopeId);
  const el = document.createElement("div");
  el.contentEditable = "true";
  document.body.appendChild(el);
  handle.editorRef.current = el;
  return { handle, el };
};

const sessionPill = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('[data-type="session"]');

describe("session pill in the composer", () => {
  afterEach(() => {
    usePromptEditorStore.setState({ scopes: {} });
    document.body.innerHTML = "";
  });

  it("reads as the session's title instead of its id", () => {
    const { handle, el } = mountEditor("tab:composer");

    handle.addSessionPart(TASK_ID, "ch/8a0f", "Claude Codeが重い理由");

    expect(sessionPill(el)?.textContent).toBe("@Claude Codeが重い理由");
    expect(sessionPill(el)?.dataset.title).toBe("Claude Codeが重い理由");
    expect(handle.getContextEntries()).toEqual([
      { kind: "session", taskId: TASK_ID, branch: "ch/8a0f" },
    ]);
  });

  it("cuts a long title to its opening, like a mention in prose", () => {
    const { handle, el } = mountEditor("tab:composer");
    const title =
      "スマホ通話アプリの画面モックと機能対照表を Allo と Fin から作る";

    handle.addSessionPart(TASK_ID, null, title);

    const text = sessionPill(el)?.textContent ?? "";
    expect(text.startsWith("@スマホ通話アプリの画面モック")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(sessionPill(el)?.dataset.title).toBe(title);
  });

  it("falls back to the short id for an untitled session", () => {
    const { handle, el } = mountEditor("tab:composer");

    handle.addSessionPart(TASK_ID, null, "  ");

    expect(sessionPill(el)?.textContent).toBe("@79d441b9");
  });

  it("keeps the title label when the composer is rebuilt from its draft", () => {
    const { handle, el } = mountEditor("tab:composer");
    handle.addSessionPart(TASK_ID, null, "Claude Codeが重い理由");

    el.replaceChildren();
    handle.syncDomFromStore();

    expect(sessionPill(el)?.textContent).toBe("@Claude Codeが重い理由");
    expect(sessionPill(el)?.dataset.title).toBe("Claude Codeが重い理由");
  });
});
