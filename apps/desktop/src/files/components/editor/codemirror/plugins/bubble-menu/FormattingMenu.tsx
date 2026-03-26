
/**
 * Default formatting menu for the BubbleMenu
 *
 * Provides common markdown formatting buttons (bold, italic, code, etc.)
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { EditorView } from "@codemirror/view";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Highlighter,
  Link,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { BubbleMenuButton, BubbleMenuSeparator } from "./BubbleMenu";
import {
  insertLink,
  isBold,
  isCode,
  isHighlight,
  isItalic,
  isStrikethrough,
  toggleBold,
  toggleCode,
  toggleHighlight,
  toggleItalic,
  toggleStrikethrough,
} from "./formatting-commands";

interface FormattingMenuProps {
  /** The CodeMirror EditorView instance */
  view: EditorView | null;
}

interface FormattingState {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  highlight: boolean;
}

const getFormattingState = (view: EditorView | null): FormattingState => ({
  bold: view ? isBold(view) : false,
  italic: view ? isItalic(view) : false,
  strikethrough: view ? isStrikethrough(view) : false,
  code: view ? isCode(view) : false,
  highlight: view ? isHighlight(view) : false,
});

const formattingStatesEqual = (a: FormattingState, b: FormattingState) =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.strikethrough === b.strikethrough &&
  a.code === b.code &&
  a.highlight === b.highlight;

/**
 * Default formatting menu with common markdown actions
 */
export function FormattingMenu({ view }: FormattingMenuProps) {
  const [formattingState, setFormattingState] = useState<FormattingState>(() =>
    getFormattingState(view),
  );
  const lastStateRef = useRef<FormattingState>(formattingState);

  useEffect(() => {
    const nextState = getFormattingState(view);
    setFormattingState(nextState);
    lastStateRef.current = nextState;

    if (!view) {
      return;
    }

    let rafId: number;

    const checkState = () => {
      const currentState = getFormattingState(view);
      if (!formattingStatesEqual(currentState, lastStateRef.current)) {
        lastStateRef.current = currentState;
        setFormattingState(currentState);
      }
      rafId = requestAnimationFrame(checkState);
    };

    rafId = requestAnimationFrame(checkState);

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [view]);

  const isDisabled = !view;

  const handleBold = useCallback(
    (_event?: MouseEvent<HTMLButtonElement>) => {
      if (view) {
        toggleBold(view);
        view.focus();
      }
    },
    [view],
  );

  const handleItalic = useCallback(
    (_event?: MouseEvent<HTMLButtonElement>) => {
      if (view) {
        toggleItalic(view);
        view.focus();
      }
    },
    [view],
  );

  const handleStrikethrough = useCallback(
    (_event?: MouseEvent<HTMLButtonElement>) => {
      if (view) {
        toggleStrikethrough(view);
        view.focus();
      }
    },
    [view],
  );

  const handleCode = useCallback(
    (_event?: MouseEvent<HTMLButtonElement>) => {
      if (view) {
        toggleCode(view);
        view.focus();
      }
    },
    [view],
  );

  const handleHighlight = useCallback(
    (_event?: MouseEvent<HTMLButtonElement>) => {
      if (view) {
        toggleHighlight(view);
        view.focus();
      }
    },
    [view],
  );

  const handleLink = useCallback(
    (_event?: MouseEvent<HTMLButtonElement>) => {
      if (view) {
        insertLink(view);
        view.focus();
      }
    },
    [view],
  );

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <BubbleMenuButton
            label="Bold (Ctrl+B)"
            onClick={handleBold}
            active={formattingState.bold}
            disabled={isDisabled}
          >
            <Bold className="h-4 w-4" />
          </BubbleMenuButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          Bold (Ctrl+B)
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <BubbleMenuButton
            label="Italic (Ctrl+I)"
            onClick={handleItalic}
            active={formattingState.italic}
            disabled={isDisabled}
          >
            <Italic className="h-4 w-4" />
          </BubbleMenuButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          Italic (Ctrl+I)
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <BubbleMenuButton
            label="Strikethrough"
            onClick={handleStrikethrough}
            active={formattingState.strikethrough}
            disabled={isDisabled}
          >
            <Strikethrough className="h-4 w-4" />
          </BubbleMenuButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          Strikethrough
        </TooltipContent>
      </Tooltip>
      <BubbleMenuSeparator />
      <Tooltip>
        <TooltipTrigger asChild>
          <BubbleMenuButton
            label="Inline Code"
            onClick={handleCode}
            active={formattingState.code}
            disabled={isDisabled}
          >
            <Code className="h-4 w-4" />
          </BubbleMenuButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          Inline Code
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <BubbleMenuButton
            label="Highlight"
            onClick={handleHighlight}
            active={formattingState.highlight}
            disabled={isDisabled}
          >
            <Highlighter className="h-4 w-4" />
          </BubbleMenuButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          Highlight
        </TooltipContent>
      </Tooltip>
      <BubbleMenuSeparator />
      <Tooltip>
        <TooltipTrigger asChild>
          <BubbleMenuButton
            label="Insert Link"
            onClick={handleLink}
            disabled={isDisabled}
          >
            <Link className="h-4 w-4" />
          </BubbleMenuButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          Insert Link
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
