/**
 * BubbleMenu module exports
 *
 * Provides a text selection menu for CodeMirror 6 editors.
 */

export {
  bubbleMenuState,
  setBubbleMenuState,
  createBubbleMenuPlugin,
  bubbleMenuExtension,
  type BubbleMenuState,
  type BubbleMenuPluginConfig,
} from "./bubble-menu-plugin";

export {
  BubbleMenu,
  BubbleMenuButton,
  BubbleMenuSeparator,
  type BubbleMenuProps,
  type BubbleMenuButtonProps,
  type BubbleMenuPlacement,
} from "./BubbleMenu";

export {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleCode,
  toggleHighlight,
  insertLink,
  isBold,
  isItalic,
  isStrikethrough,
  isCode,
  isHighlight,
} from "./formatting-commands";

export { FormattingMenu } from "./FormattingMenu";
