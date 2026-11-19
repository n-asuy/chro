import { cn } from "@/lib/cn";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Two lines of user-message text (text-sm, leading-relaxed: 22.75px a line).
 * The session view pins the prompt to this height so a long prompt does not
 * eat the reading space; previews use the same ceiling so a prompt reads the
 * same wherever it is shown.
 */
export const USER_MESSAGE_TWO_LINES_HEIGHT = 46;

/**
 * Tracks whether content overflows `collapsedHeight` (re-measured on resize)
 * and whether the user has expanded it. Shared by every collapsible user
 * message so the overflow rule lives in one place.
 */
export function useCollapsibleOverflow(collapsedHeight: number) {
  const [expanded, setExpanded] = useState(false);
  const [needsExpansion, setNeedsExpansion] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => setNeedsExpansion(el.scrollHeight > collapsedHeight);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsedHeight]);

  return {
    contentRef,
    expanded,
    setExpanded,
    needsExpansion,
    collapsed: !expanded && needsExpansion,
  };
}

interface CollapsibleMessageProps {
  children: ReactNode;
  /**
   * Tailwind gradient `from-*` color matching the surrounding background, so the
   * fade over the clipped content blends in (e.g. `from-popover`).
   */
  fadeClassName: string;
}

/**
 * Collapses a user message to two lines with a gradient fade + chevron to
 * expand, matching the session view's pinned user message but without its
 * conversation-specific layout so it fits inside preview panels. Short content
 * renders in full with no affordance.
 */
export function CollapsibleMessage({
  children,
  fadeClassName,
}: CollapsibleMessageProps) {
  const { contentRef, expanded, setExpanded, needsExpansion, collapsed } =
    useCollapsibleOverflow(USER_MESSAGE_TWO_LINES_HEIGHT);

  return (
    <div>
      <div
        ref={contentRef}
        className={cn("relative", collapsed && "overflow-hidden")}
        style={{
          maxHeight: collapsed ? USER_MESSAGE_TWO_LINES_HEIGHT : undefined,
        }}
      >
        {children}
        {collapsed ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="Expand"
            className={cn(
              "absolute inset-x-0 bottom-0 flex h-5 items-end justify-center bg-gradient-to-t to-transparent",
              fadeClassName,
            )}
          >
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </button>
        ) : null}
      </div>
      {expanded && needsExpansion ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Collapse"
          className="flex w-full items-center justify-center pt-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className="h-4 w-4 rotate-180" />
        </button>
      ) : null}
    </div>
  );
}
