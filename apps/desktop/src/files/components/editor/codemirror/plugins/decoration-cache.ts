/**
 * Cache a document-only computation by the immutable `Text` instance.
 *
 * CodeMirror's `state.doc` is an immutable `Text`; a selection-only transaction
 * (cursor movement, click) keeps the SAME `Text` instance, while any edit
 * produces a new one. Prose decoration builders scan the whole syntax tree to
 * find blocks (mermaid/math/tables); that scan depends only on the document, so
 * memoizing it here makes cursor movement reuse the scan instead of re-walking
 * the tree. A `WeakMap` keyed by `Text` drops entries as old documents are
 * collected.
 */
import type { EditorState, Text } from "@codemirror/state";

export function memoizeByDoc<T>(
  compute: (state: EditorState) => T,
): (state: EditorState) => T {
  const cache = new WeakMap<Text, T>();
  return (state) => {
    const key = state.doc;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const value = compute(state);
    cache.set(key, value);
    return value;
  };
}
