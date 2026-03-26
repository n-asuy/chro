/**
 * CodeMirror 6 WYSIWYG Editor
 * Main exports for the editor component
 */

export {
  CodeMirrorEditor,
  type CodeMirrorEditorHandle,
} from "./codemirror-editor";
export { createWysiwygPlugin, type WysiwygConfig } from "./wysiwyg";

// Bubble menu exports
export {
  BubbleMenu,
  BubbleMenuButton,
  BubbleMenuSeparator,
  FormattingMenu,
  bubbleMenuState,
  bubbleMenuExtension,
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleCode,
  toggleHighlight,
  insertLink,
  type BubbleMenuProps,
  type BubbleMenuPlacement,
  type BubbleMenuState,
} from "./plugins/bubble-menu";
