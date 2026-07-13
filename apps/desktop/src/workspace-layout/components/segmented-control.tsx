import { useProximityHover } from "@/session/hooks/use-proximity-hover";
import { cn } from "@/lib/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Icon-only segmented control adapted from a reference segmented-tabs pattern.
 * A single muted track holds the segments; the selected segment is
 * a raised pill that springs between positions, and a fainter pill follows the
 * pointer via proximity hover (the nearest segment activates, so the indicator
 * morphs instead of snapping per-segment). Adapted to chro's stack — no shape /
 * surface / icon contexts, just framer-motion, lucide and shadcn tokens.
 */

const SPRING_MOVE = { type: "spring", duration: 0.22, bounce: 0.1 } as const;
const SPRING_FAST = { type: "spring", duration: 0.1, bounce: 0 } as const;

export interface SegmentedItem<T extends string = string> {
  value: T;
  icon: LucideIcon;
  /** Accessible name, shown as the tooltip. */
  label: string;
}

interface SegmentedControlProps<T extends string> {
  items: SegmentedItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name for the tablist. */
  label?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  items,
  value,
  onValueChange,
  label,
  className,
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isMouseInside = useRef(false);

  const {
    activeIndex: hoveredIndex,
    setActiveIndex: setHoveredIndex,
    itemRects,
    handlers,
    registerItem,
    measureItems,
  } = useProximityHover(containerRef, { axis: "x" });

  const selectedIndex = items.findIndex((item) => item.value === value);

  // Remeasure when the set of segments changes.
  useEffect(() => {
    measureItems();
  }, [measureItems, items.length]);

  // Remeasure on container resize (dock width drag, font load, …).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measureItems());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureItems]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      isMouseInside.current = true;
      handlers.onMouseMove(e);
    },
    [handlers],
  );

  const handleMouseLeave = useCallback(() => {
    isMouseInside.current = false;
    handlers.onMouseLeave();
  }, [handlers]);

  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const selectedRect = selectedIndex >= 0 ? itemRects[selectedIndex] : null;
  const hoverRect = hoveredIndex !== null ? itemRects[hoveredIndex] : null;
  const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
  const isHoveringSelected = hoveredIndex === selectedIndex;
  const isHovering = hoveredIndex !== null && !isHoveringSelected;

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    const current = tabs.indexOf(e.target as HTMLElement);
    if (current === -1) return;

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next =
        e.key === "ArrowRight"
          ? (current + 1) % tabs.length
          : (current - 1 + tabs.length) % tabs.length;
      tabs[next]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      tabs[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      tabs[tabs.length - 1]?.focus();
    }
  }, []);

  return (
    <TooltipProvider delayDuration={150}>
      <div
        ref={containerRef}
        role="tablist"
        aria-label={label}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onKeyDown={handleKeyDown}
        onFocus={(e) => {
          const indexAttr = (e.target as HTMLElement)
            .closest("[data-proximity-index]")
            ?.getAttribute("data-proximity-index");
          if (indexAttr == null) return;
          const idx = Number(indexAttr);
          setHoveredIndex(idx);
          setFocusedIndex(
            (e.target as HTMLElement).matches(":focus-visible") ? idx : null,
          );
        }}
        onBlur={(e) => {
          if (containerRef.current?.contains(e.relatedTarget as Node)) return;
          setFocusedIndex(null);
          if (isMouseInside.current) return;
          setHoveredIndex(null);
        }}
        className={cn(
          "relative inline-flex select-none items-center gap-0.5 rounded-full bg-muted p-1",
          className,
        )}
      >
        {/* Selected pill — raised surface that springs between segments. */}
        {selectedRect && (
          <motion.div
            className="pointer-events-none absolute rounded-full bg-background shadow-sm ring-1 ring-border/50"
            initial={false}
            animate={{
              left: selectedRect.left,
              width: selectedRect.width,
              top: selectedRect.top,
              height: selectedRect.height,
              opacity: isHovering ? 0.85 : 1,
            }}
            transition={{ ...SPRING_MOVE, opacity: { duration: 0.08 } }}
          />
        )}

        {/* Hover pill — fainter, follows the pointer to non-selected segments. */}
        <AnimatePresence>
          {hoverRect && !isHoveringSelected && selectedRect && (
            <motion.div
              className="pointer-events-none absolute rounded-full bg-foreground/[0.06]"
              initial={{
                left: selectedRect.left,
                width: selectedRect.width,
                top: selectedRect.top,
                height: selectedRect.height,
                opacity: 0,
              }}
              animate={{
                left: hoverRect.left,
                width: hoverRect.width,
                top: hoverRect.top,
                height: hoverRect.height,
                opacity: 1,
              }}
              exit={
                !isMouseInside.current && selectedRect
                  ? {
                      left: selectedRect.left,
                      width: selectedRect.width,
                      top: selectedRect.top,
                      height: selectedRect.height,
                      opacity: 0,
                      transition: {
                        ...SPRING_MOVE,
                        opacity: { duration: 0.06 },
                      },
                    }
                  : { opacity: 0, transition: { duration: 0.06 } }
              }
              transition={{ ...SPRING_FAST, opacity: { duration: 0.08 } }}
            />
          )}
        </AnimatePresence>

        {/* Focus ring */}
        <AnimatePresence>
          {focusRect && (
            <motion.div
              className="pointer-events-none absolute z-20 rounded-full border border-primary"
              initial={false}
              animate={{
                left: focusRect.left - 2,
                top: focusRect.top - 2,
                width: focusRect.width + 4,
                height: focusRect.height + 4,
              }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              transition={SPRING_FAST}
            />
          )}
        </AnimatePresence>

        {items.map((item, index) => (
          <Segment
            key={item.value}
            index={index}
            item={item}
            isSelected={index === selectedIndex}
            isActive={hoveredIndex === index || index === selectedIndex}
            registerItem={registerItem}
            onSelect={() => onValueChange(item.value)}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}

interface SegmentProps {
  index: number;
  item: SegmentedItem;
  isSelected: boolean;
  isActive: boolean;
  registerItem: (index: number, element: HTMLElement | null) => void;
  onSelect: () => void;
}

function Segment({
  index,
  item,
  isSelected,
  isActive,
  registerItem,
  onSelect,
}: SegmentProps) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    registerItem(index, ref.current);
    return () => registerItem(index, null);
  }, [index, registerItem]);

  const Icon = item.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          role="tab"
          aria-selected={isSelected}
          aria-label={item.label}
          tabIndex={isSelected ? 0 : -1}
          data-proximity-index={index}
          onClick={onSelect}
          className="relative z-10 inline-flex h-7 w-8 cursor-pointer items-center justify-center rounded-full border-none bg-transparent outline-none"
        >
          <Icon
            size={16}
            strokeWidth={isActive ? 2 : 1.5}
            className={cn(
              "transition-[color,stroke-width] duration-100",
              isActive ? "text-foreground" : "text-muted-foreground",
            )}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center">
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}
