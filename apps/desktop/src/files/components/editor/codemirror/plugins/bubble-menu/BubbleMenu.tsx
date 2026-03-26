
/**
 * BubbleMenu React Component for CodeMirror 6
 * Floating toolbar for text selections
 *
 * Renders a floating toolbar when text is selected in the editor.
 * Uses a portal to render outside the editor DOM for proper z-index handling.
 */

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
  type CSSProperties,
  type ButtonHTMLAttributes,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import { bubbleMenuState, type BubbleMenuState } from "./bubble-menu-plugin";
import { cn } from "@chro/ui/utils";

/**
 * Placement options for the bubble menu
 */
export type BubbleMenuPlacement =
  | "top"
  | "bottom"
  | "top-start"
  | "top-end"
  | "bottom-start"
  | "bottom-end";

/**
 * Props for the BubbleMenu component
 */
export interface BubbleMenuProps {
  /** The CodeMirror EditorView instance */
  view: EditorView | null;
  /** Menu content - typically formatting buttons */
  children: ReactNode;
  /** Additional CSS class names */
  className?: string;
  /** Preferred placement of the menu relative to selection */
  placement?: BubbleMenuPlacement;
  /** Offset from the selection in pixels */
  offset?: number;
  /** Container element to render the portal into */
  container?: HTMLElement | null;
  /** Callback when menu visibility changes */
  onVisibilityChange?: (visible: boolean) => void;
  /** Custom function to determine if menu should show */
  shouldShow?: (state: BubbleMenuState) => boolean;
}

/**
 * Calculate menu position based on selection rect and placement
 */
function calculatePosition(
  rect: DOMRect,
  menuRect: DOMRect,
  placement: BubbleMenuPlacement,
  offset: number,
): CSSProperties {
  let top: number;
  let left: number;

  // Calculate vertical position
  if (placement.startsWith("top")) {
    top = rect.top - menuRect.height - offset;
    // Flip to bottom if would go off screen
    if (top < 0) {
      top = rect.bottom + offset;
    }
  } else {
    top = rect.bottom + offset;
    // Flip to top if would go off screen
    if (top + menuRect.height > window.innerHeight) {
      top = rect.top - menuRect.height - offset;
    }
  }

  // Calculate horizontal position
  if (placement.endsWith("-start")) {
    left = rect.left;
  } else if (placement.endsWith("-end")) {
    left = rect.right - menuRect.width;
  } else {
    // Center horizontally
    left = rect.left + rect.width / 2 - menuRect.width / 2;
  }

  // Keep within viewport bounds
  left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
  top = Math.max(8, top);

  return {
    position: "fixed",
    top: `${top}px`,
    left: `${left}px`,
    zIndex: 50,
  };
}

/**
 * Safely get bubble menu state from view
 */
function getBubbleMenuState(view: EditorView): BubbleMenuState | null {
  try {
    return view.state.field(bubbleMenuState, false) ?? null;
  } catch {
    // Field not registered
    return null;
  }
}

/**
 * Compare two BubbleMenuState objects for equality
 */
function statesAreEqual(
  a: BubbleMenuState | null,
  b: BubbleMenuState | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.visible === b.visible &&
    a.from === b.from &&
    a.to === b.to &&
    a.selectedText === b.selectedText &&
    // Compare rect values if both exist
    (a.rect === b.rect ||
      (a.rect !== null &&
        b.rect !== null &&
        a.rect.top === b.rect.top &&
        a.rect.left === b.rect.left &&
        a.rect.width === b.rect.width &&
        a.rect.height === b.rect.height))
  );
}

/**
 * Hook to subscribe to bubble menu state from CodeMirror
 */
function useBubbleMenuState(view: EditorView | null): BubbleMenuState | null {
  const [state, setState] = useState<BubbleMenuState | null>(null);
  const lastStateRef = useRef<BubbleMenuState | null>(null);

  useEffect(() => {
    if (!view) {
      setState(null);
      lastStateRef.current = null;
      return;
    }

    // Get initial state
    const initialState = getBubbleMenuState(view);
    if (initialState) {
      setState(initialState);
      lastStateRef.current = initialState;
    }

    // Use a MutationObserver-like pattern by checking state on animation frames
    // This is more reliable than trying to intercept all dispatches
    let rafId: number;

    const checkState = () => {
      const currentState = getBubbleMenuState(view);
      if (currentState && !statesAreEqual(currentState, lastStateRef.current)) {
        lastStateRef.current = currentState;
        setState(currentState);
      }
      rafId = requestAnimationFrame(checkState);
    };

    rafId = requestAnimationFrame(checkState);

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [view]);

  return state;
}

/**
 * BubbleMenu component that renders a floating toolbar on text selection
 */
export function BubbleMenu({
  view,
  children,
  className,
  placement = "top",
  offset = 8,
  container,
  onVisibilityChange,
  shouldShow,
}: BubbleMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });
  const [isPositioned, setIsPositioned] = useState(false);
  const state = useBubbleMenuState(view);

  // Determine if menu should be shown
  const shouldDisplay =
    state && state.rect && (shouldShow ? shouldShow(state) : state.visible);

  // Update position when state changes
  useEffect(() => {
    if (!shouldDisplay || !state?.rect) {
      setIsPositioned(false);
      return;
    }

    // Use RAF to measure menu after render
    const rafId = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) {
        return;
      }

      const menuRect = menu.getBoundingClientRect();
      const newPosition = calculatePosition(
        state.rect!,
        menuRect,
        placement,
        offset,
      );
      setPosition(newPosition);
      setIsPositioned(true);
    });

    return () => cancelAnimationFrame(rafId);
  }, [shouldDisplay, state?.rect, placement, offset]);

  // Notify parent of visibility changes
  useEffect(() => {
    onVisibilityChange?.(isPositioned && !!shouldDisplay);
  }, [isPositioned, shouldDisplay, onVisibilityChange]);

  // Handle mouse events to prevent focus loss
  const handleMouseDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
    // Prevent the menu from stealing focus from the editor
    e.preventDefault();
  }, []);

  // SSR guard: don't render on server
  if (typeof window === "undefined") {
    return null;
  }

  // Don't render if no state or not meant to display
  if (!shouldDisplay) {
    return null;
  }

  const content = (
    <div
      ref={menuRef}
      role="toolbar"
      aria-label="Text formatting"
      className={cn(
        "flex items-center gap-0.5 rounded border border-border/50 bg-popover p-1 shadow-sm",
        className,
      )}
      style={position}
      onMouseDown={handleMouseDown}
    >
      {children}
    </div>
  );

  // Render into portal if container specified, otherwise render inline
  const portalContainer = container ?? document.body;
  return createPortal(content, portalContainer);
}

/**
 * Props for individual menu button
 */
export interface BubbleMenuButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  /** Button label for accessibility */
  label: string;
  /** Whether the button represents an active state */
  active?: boolean;
  /** Click handler */
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Button content (icon) */
  children: ReactNode;
}

/**
 * Standard button for use within BubbleMenu
 */
export const BubbleMenuButton = forwardRef<
  HTMLButtonElement,
  BubbleMenuButtonProps
>(function BubbleMenuButton(
  {
    label,
    active = false,
    onClick,
    children,
    className,
    disabled = false,
    onMouseDown,
    type,
    ...props
  },
  ref,
) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      onClick(event);
    },
    [onClick],
  );

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onMouseDown?.(event);
    },
    [onMouseDown],
  );

  return (
    <button
      {...props}
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-sm",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        active && "bg-accent text-accent-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
});

/**
 * Separator for grouping buttons in the menu
 */
export function BubbleMenuSeparator({ className }: { className?: string }) {
  return (
    <div
      className={cn("mx-0.5 h-5 w-px bg-border", className)}
      role="separator"
    />
  );
}
