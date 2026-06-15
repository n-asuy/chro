import { cn } from "@/lib/cn";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** Collapsed height ceiling before the expand affordance appears. */
const COLLAPSED_MAX_HEIGHT = 180;

interface CollapsibleMessageProps {
  children: ReactNode;
  /**
   * Tailwind gradient `from-*` color matching the surrounding background, so the
   * fade over the clipped content blends in (e.g. `from-popover`).
   */
  fadeClassName: string;
}

/**
 * Collapses long content to a fixed height with a gradient fade + chevron to
 * expand, mirroring the session view's expandable user message but without its
 * conversation-specific layout so it fits inside the hover-preview panel. Short
 * content renders in full with no affordance.
 */
export function CollapsibleMessage({
  children,
  fadeClassName,
}: CollapsibleMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const [needsExpansion, setNeedsExpansion] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => {
      setNeedsExpansion(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 8);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div>
      <div
        ref={contentRef}
        className={cn(
          "relative",
          !expanded && needsExpansion && "overflow-hidden",
        )}
        style={{
          maxHeight:
            expanded || !needsExpansion ? undefined : COLLAPSED_MAX_HEIGHT,
        }}
      >
        {children}
        {!expanded && needsExpansion ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label="Expand"
            className={cn(
              "absolute inset-x-0 bottom-0 flex h-10 items-end justify-center bg-gradient-to-t to-transparent",
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
