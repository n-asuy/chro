import { cn } from "@/lib/cn";
import type { DropEdge } from "../types";

interface SplitDropOverlayProps {
  leafId: string;
  edge: DropEdge | null;
  container: { width: number; height: number } | null;
}

/**
 * Renders a translucent indicator showing where a dragged tab will land
 * relative to the hovered pane: the pane is divided into 5 zones (center +
 * 4 edges) and the corresponding region highlights as the pointer moves.
 *
 * Zone resolution is driven by PaneDndContext's onDragMove handler, which
 * publishes the resolved edge via usePaneDropPreview; this component only
 * paints feedback for that edge.
 */
export function SplitDropOverlay({ edge }: SplitDropOverlayProps) {
  if (!edge) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div
        className={cn(
          "absolute bg-primary/15 ring-1 ring-primary",
          edgeClass(edge),
        )}
      />
    </div>
  );
}

function edgeClass(edge: DropEdge): string {
  switch (edge) {
    case "center":
      return "inset-2 rounded";
    case "left":
      return "inset-y-2 left-2 w-1/2 rounded";
    case "right":
      return "inset-y-2 right-2 w-1/2 rounded";
    case "top":
      return "inset-x-2 top-2 h-1/2 rounded";
    case "bottom":
      return "inset-x-2 bottom-2 h-1/2 rounded";
  }
}
