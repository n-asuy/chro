/**
 * @vitest-environment jsdom
 */
import { getChunks } from "@codemirror/merge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MergeDiffView, createMergeDiffView } from "../merge-diff-view";

const ORIGINAL = "# Title\n\nalpha line\nshared line\n";
const MODIFIED = "# Title\n\nbeta line\nshared line\n";

let view: MergeDiffView | null = null;

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 50));

const mount = (
  options: Partial<Parameters<typeof createMergeDiffView>[0]> = {},
) => {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const onEdit = vi.fn();
  view = createMergeDiffView({
    parent,
    original: ORIGINAL,
    text: MODIFIED,
    layout: "split",
    editable: true,
    dark: false,
    onEdit,
    ...options,
  });
  return { view, onEdit, parent };
};

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("createMergeDiffView", () => {
  it("shows the original on the left and the working text on the right", () => {
    const { view, parent } = mount();
    expect(parent.querySelector(".cm-mergeView")).not.toBeNull();
    expect(view.original()).toBe(ORIGINAL);
    expect(view.text()).toBe(MODIFIED);
  });

  it("reports user edits of the working text", () => {
    const { view, onEdit } = mount();
    view.editor.dispatch({ changes: { from: 0, insert: "x" } });
    expect(onEdit).toHaveBeenCalledWith(`x${MODIFIED}`);
  });

  it("does not report text that came from disk", () => {
    const { view, onEdit } = mount();
    view.replaceText("# Title\n\ngamma line\nshared line\n");
    expect(view.text()).toBe("# Title\n\ngamma line\nshared line\n");
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("keeps the cursor when disk text changes elsewhere", () => {
    const { view } = mount();
    const end = view.editor.state.doc.length;
    view.editor.dispatch({ selection: { anchor: end } });
    view.replaceText(MODIFIED.replace("# Title", "# Renamed title"));
    expect(view.editor.state.selection.main.head).toBe(
      view.editor.state.doc.length,
    );
  });

  it("follows a new base without touching the working text", () => {
    const { view, onEdit } = mount();
    view.replaceOriginal(MODIFIED);
    expect(view.original()).toBe(MODIFIED);
    expect(view.text()).toBe(MODIFIED);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("reverts a changed block to the original and reports it", async () => {
    const { view, onEdit, parent } = mount();
    // Revert controls are placed in the view's measure cycle.
    await nextFrame();
    const revert = parent.querySelector<HTMLElement>(".cm-merge-revert > *");
    expect(revert).not.toBeNull();
    revert?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.text()).toBe(ORIGINAL);
    expect(onEdit).toHaveBeenLastCalledWith(ORIGINAL);
  });

  it("is read-only when the file cannot be written", async () => {
    const { view, parent } = mount({ editable: false });
    await nextFrame();
    expect(view.editor.state.readOnly).toBe(true);
    expect(parent.querySelector(".cm-merge-revert > *")).toBeNull();
  });

  it("shows deleted lines inline in the unified layout", () => {
    const { view, parent } = mount({ layout: "unified" });
    expect(parent.querySelector(".cm-mergeView")).toBeNull();
    expect(getChunks(view.editor.state)?.chunks).toHaveLength(1);
    expect(parent.querySelector(".cm-deletedChunk")?.textContent).toContain(
      "alpha line",
    );
  });

  it("follows a new base in the unified layout", () => {
    const { view } = mount({ layout: "unified" });
    view.replaceOriginal(MODIFIED);
    expect(view.original()).toBe(MODIFIED);
    expect(getChunks(view.editor.state)?.chunks).toHaveLength(0);
  });
});
