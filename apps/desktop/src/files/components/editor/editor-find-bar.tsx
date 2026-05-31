/**
 * Obsidian-style find bar rendered above the file content.
 *
 * Drives an underlying CodeMirror search via the editor's imperative handle,
 * so the bar can float at the top of the file view (above title and
 * frontmatter) instead of being buried inside the editor pane. The visible
 * chrome comes from the shared {@link FindBar}; this component only wires it to
 * the editor.
 */

import { FindBar } from "@/components/find-bar";
import { type RefObject, useEffect, useRef } from "react";
import type { CodeMirrorEditorHandle } from "./codemirror";

interface EditorFindBarProps {
  open: boolean;
  query: string;
  onQueryChange: (next: string) => void;
  onClose: () => void;
  editorRef: RefObject<CodeMirrorEditorHandle | null>;
}

export function EditorFindBar({
  open,
  query,
  onQueryChange,
  onClose,
  editorRef,
}: EditorFindBarProps) {
  // Read the latest query without making the open-effect depend on it, so that
  // typing doesn't re-run the editor sync.
  const queryRef = useRef(query);
  queryRef.current = query;

  // When the bar opens, sync the editor's search query with whatever the host
  // already has so existing matches highlight immediately.
  useEffect(() => {
    if (!open) return;
    editorRef.current?.setSearchQuery(queryRef.current);
  }, [open, editorRef]);

  // Clear the editor's highlighted matches whenever the bar is closed so they
  // don't linger on top of the document.
  useEffect(() => {
    if (!open) {
      editorRef.current?.clearSearch();
    }
  }, [open, editorRef]);

  if (!open) return null;

  const handleQueryChange = (value: string) => {
    onQueryChange(value);
    editorRef.current?.setSearchQuery(value);
  };

  return (
    <FindBar
      query={query}
      onQueryChange={handleQueryChange}
      onNext={() => editorRef.current?.findNext()}
      onPrevious={() => editorRef.current?.findPrevious()}
      onClose={onClose}
      ariaLabel="Find in file"
    />
  );
}
