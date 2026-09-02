/**
 * Cache a syntax-tree scan by the document it ran on and how far it was parsed.
 *
 * CodeMirror's `state.doc` is an immutable `Text`; a selection-only transaction
 * (cursor movement, click) keeps the SAME `Text` instance, while any edit
 * produces a new one. Prose decoration builders scan the whole syntax tree to
 * find blocks (mermaid/math/tables); that scan depends only on the document and
 * its parse, so memoizing it here makes cursor movement reuse the scan instead
 * of re-walking the tree. A `WeakMap` keyed by `Text` drops entries as old
 * documents are collected.
 *
 * The parsed length is part of the key because the background parser extends
 * the tree over an unchanged document: caching by `Text` alone would keep
 * serving the scan taken when only the first ~3000 characters were parsed.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";

interface CacheEntry<T> {
  parsedLength: number;
  value: T;
}

export function memoizeByParsedDoc<T>(
  compute: (state: EditorState) => T,
): (state: EditorState) => T {
  const cache = new WeakMap<Text, CacheEntry<T>>();
  return (state) => {
    const key = state.doc;
    const parsedLength = syntaxTree(state).length;
    const cached = cache.get(key);
    if (cached && cached.parsedLength === parsedLength) return cached.value;
    const value = compute(state);
    cache.set(key, { parsedLength, value });
    return value;
  };
}
