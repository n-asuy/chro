import {
  type ComponentType,
  memo,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { useRightDockStore } from "../state/right-dock-store";
import { MAX_DOCK_WIDTH, MIN_DOCK_WIDTH } from "../types";
import { DockSideProvider } from "./dock-store-context";

interface RightDockProps {
  filetree: ComponentType;
  search: ComponentType;
  sourceControl: ComponentType;
}

/**
 * Mirror of {@link LeftDock} on the right side of the workspace. When no
 * panel is active (or the dock is collapsed) the dock renders nothing and
 * the center pane fills the remaining space.
 */
export const RightDock = memo(function RightDock({
  filetree: FileTreePanel,
  search: SearchPanel,
  sourceControl: SourceControlPanel,
}: RightDockProps) {
  const activePanel = useRightDockStore((s) => s.activePanel);
  const collapsed = useRightDockStore((s) => s.collapsed);
  const width = useRightDockStore((s) => s.width);
  const setWidth = useRightDockStore((s) => s.setWidth);

  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  // Right dock resizes from its LEFT edge: dragging left grows the dock,
  // dragging right shrinks it. Invert the delta versus LeftDock.
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
      const next = drag.startWidth - (e.clientX - drag.startX);
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

  if (collapsed || !activePanel) return null;

  const renderPanel = () => {
    switch (activePanel) {
      case "filetree":
        return <FileTreePanel />;
      case "search":
        return <SearchPanel />;
      case "source-control":
        return <SourceControlPanel />;
    }
  };

  const clampedWidth = Math.min(
    MAX_DOCK_WIDTH,
    Math.max(MIN_DOCK_WIDTH, width || MIN_DOCK_WIDTH),
  );

  return (
    <DockSideProvider side="right">
      <div
        className="relative flex h-full shrink-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-background"
        style={{ width: clampedWidth }}
      >
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
          className="absolute -left-px top-0 z-10 h-full w-1 cursor-col-resize hover:bg-primary/40"
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {renderPanel()}
        </div>
      </div>
    </DockSideProvider>
  );
});
