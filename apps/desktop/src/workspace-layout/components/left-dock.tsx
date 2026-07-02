import {
  type ComponentType,
  memo,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { useDockStore } from "../state/dock-store";
import { MAX_DOCK_WIDTH, MIN_DOCK_WIDTH } from "../types";

interface LeftDockProps {
  panel: ComponentType;
}

export const LeftDock = memo(function LeftDock({
  panel: Panel,
}: LeftDockProps) {
  const collapsed = useDockStore((s) => s.collapsed);
  const width = useDockStore((s) => s.width);
  const setWidth = useDockStore((s) => s.setWidth);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStateRef.current = { startX: e.clientX, startWidth: width };
    },
    [width],
  );

  const onResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const next = drag.startWidth + (e.clientX - drag.startX);
      setWidth(next);
    },
    [setWidth],
  );

  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragStateRef.current = null;
  }, []);

  useEffect(
    () => () => {
      dragStateRef.current = null;
    },
    [],
  );

  // Closed dock renders nothing — the header's left toggle owns reopening it,
  // so there's no collapsed rail left behind. Returning null also lets the
  // parent flex gap collapse cleanly instead of reserving an empty column.
  if (collapsed) return null;

  const clampedWidth = Math.min(
    MAX_DOCK_WIDTH,
    Math.max(MIN_DOCK_WIDTH, width || MIN_DOCK_WIDTH),
  );

  return (
    <div
      ref={containerRef}
      className="relative flex h-full shrink-0 bg-transparent"
      style={{ width: clampedWidth }}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Panel />
        </div>
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={MIN_DOCK_WIDTH}
        aria-valuemax={MAX_DOCK_WIDTH}
        aria-valuenow={clampedWidth}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute -right-px top-0 z-10 h-full w-0.5 cursor-col-resize bg-transparent transition-colors duration-150 ease-out before:absolute before:inset-y-0 before:-inset-x-[3px] before:content-[''] hover:bg-primary/70"
      />
    </div>
  );
});
