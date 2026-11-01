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

export { FormattingMenu } from "./FormattingMenu";
