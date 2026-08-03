/**
 * Mounts the editor's real WYSIWYG extension set so a browser can assert what
 * the app actually paints. Bundled by probe.mjs; not part of the app.
 *
 * This deliberately goes through `createWysiwygPlugin()` rather than loading
 * the HTML plugin alone: competing prose plugins racing for the same range are
 * exactly what a plugin-in-isolation check cannot rule out.
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createWysiwygPlugin } from "../../src/files/components/editor/codemirror/wysiwyg";

(window as unknown as { mountEditor: (doc: string) => void }).mountEditor = (
  doc: string,
) => {
  const parent = document.getElementById("editor")!;
  parent.innerHTML = "";
  new EditorView({
    state: EditorState.create({
      doc,
      // Cursor away from the block, otherwise the plugin shows raw source.
      selection: EditorSelection.single(doc.length),
      extensions: [EditorView.lineWrapping, createWysiwygPlugin()],
    }),
    parent,
  });
};
