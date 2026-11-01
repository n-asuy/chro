/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  dropFileReferences,
  getPromptEditorHandle,
  usePromptEditorStore,
} from "./prompt-editor-store";

const mountEditor = (scopeId: string) => {
  const handle = getPromptEditorHandle(scopeId);
  const el = document.createElement("div");
  el.contentEditable = "true";
  document.body.appendChild(el);
  handle.editorRef.current = el;
  return { handle, el };
};

describe("dropFileReferences", () => {
  afterEach(() => {
    usePromptEditorStore.setState({ scopes: {} });
    document.body.innerHTML = "";
  });

  it("inserts into the composer under the pointer, not the last active one", () => {
    const target = mountEditor("tab:target");
    const other = mountEditor("tab:other");
    other.handle.activate();

    const dropped = dropFileReferences(
      target.el,
      [
        { path: "/src/app.ts", isDir: false },
        { path: "/docs", isDir: true },
      ],
      0,
      0,
    );

    expect(dropped).toBe(true);
    expect(target.handle.getContextEntries()).toEqual([
      { kind: "file", path: "/src/app.ts", isFile: true },
      { kind: "file", path: "/docs", isFile: false },
    ]);
    expect(other.handle.getContextEntries()).toEqual([]);
  });

  it("ignores an element that is not a mounted composer", () => {
    mountEditor("tab:target");
    const stray = document.createElement("div");
    document.body.appendChild(stray);

    expect(
      dropFileReferences(stray, [{ path: "/a.ts", isDir: false }], 0, 0),
    ).toBe(false);
  });
});
