import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { useLayoutStore } from "../state/layout-store";
import type { SplitDirection } from "../types";

interface ResizeHandleProps {
  splitId: string;
  direction: SplitDirection;
  /** ref to the parent split container — used to compute new percentages */
  containerRef: React.RefObject<HTMLDivElement | null>;
  initialSizes: [number, number];
}

const MIN_PERCENT = 10;

export function ResizeHandle({
  splitId,
  direction,
  containerRef,
  initialSizes,
}: ResizeHandleProps) {
  const resize = useLayoutStore((s) => s.resizeSplit);
  const draggingRef = useRef<{
    startCoord: number;
    startSizes: [number, number];
    containerSize: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const containerSize = direction === "h" ? rect.width : rect.height;
      if (containerSize <= 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      draggingRef.current = {
        startCoord: direction === "h" ? e.clientX : e.clientY,
        startSizes: initialSizes,
        containerSize,
      };
    },
    [containerRef, direction, initialSizes],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = draggingRef.current;
      if (!drag) return;
      const coord = direction === "h" ? e.clientX : e.clientY;
      const deltaPx = coord - drag.startCoord;
      const deltaPct = (deltaPx / drag.containerSize) * 100;
      let first = drag.startSizes[0] + deltaPct;
      if (first < MIN_PERCENT) first = MIN_PERCENT;
      if (first > 100 - MIN_PERCENT) first = 100 - MIN_PERCENT;
      const second = 100 - first;
      resize(splitId, [first, second]);
    },
    [direction, resize, splitId],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      draggingRef.current = null;
    },
    [],
  );

  useEffect(() => () => {
    draggingRef.current = null;
  }, []);

  return (
    <div
      role="separator"
      aria-orientation={direction === "h" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "relative shrink-0 bg-border/60 hover:bg-primary/40",
        direction === "h"
          ? "w-px cursor-col-resize hover:w-0.5"
          : "h-px cursor-row-resize hover:h-0.5",
      )}
    />
  );
}
