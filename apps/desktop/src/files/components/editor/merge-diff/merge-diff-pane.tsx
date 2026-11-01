import { useTheme } from "@/settings/hooks/use-theme";
import { useEditorConfigStore } from "@/settings/state/editor-config-store";
import { useEffect, useRef } from "react";
import { DEFAULT_EDITOR_FONT_FAMILY } from "../codemirror/codemirror-editor";
import {
  type MergeDiffLayout,
  type MergeDiffView,
  createMergeDiffView,
} from "./merge-diff-view";

type MergeDiffPaneProps = {
  original: string;
  /**
   * The working text. Edits are reported through `onEdit`; a different value
   * coming back in (a disk change) replaces the text without being reported.
   */
  text: string;
  layout: MergeDiffLayout;
  editable: boolean;
  onEdit?: (text: string) => void;
  onSave?: () => void;
};

/** A text diff whose working side is editable; owns no document state. */
export function MergeDiffPane({
  original,
  text,
  layout,
  editable,
  onEdit,
  onSave,
}: MergeDiffPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeDiffView | null>(null);
  // Latest values, read when the view is rebuilt (layout or theme switches).
  const textRef = useRef(text);
  textRef.current = text;
  const originalRef = useRef(original);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const dark = useTheme().dataTheme === "dark";
  const fontSize = useEditorConfigStore((s) => s.config.font_size);
  const lineHeight = useEditorConfigStore((s) => s.config.line_height);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const view = createMergeDiffView({
      parent,
      original: originalRef.current,
      text: textRef.current,
      layout,
      editable,
      dark,
      onEdit: (next) => onEditRef.current?.(next),
      onSave: () => onSaveRef.current?.(),
      fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
      fontSize,
      lineHeight,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [layout, editable, dark, fontSize, lineHeight]);

  useEffect(() => {
    originalRef.current = original;
    viewRef.current?.replaceOriginal(original);
  }, [original]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.text() !== text) view.replaceText(text);
  }, [text]);

  return (
    <div
      ref={containerRef}
      className="merge-diff-editor"
      data-layout={layout}
      data-editable={editable}
    />
  );
}
