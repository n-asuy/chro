import { memo, useRef } from "react";
import { cn } from "@/lib/cn";
import { useLayoutStore } from "../state/layout-store";
import type { PaneNode, PaneSplit } from "../types";
import { PaneContainer } from "./pane-container";
import { ResizeHandle } from "./resize-handle";

export const PaneTreeView = memo(function PaneTreeView() {
  const root = useLayoutStore((s) => s.layout.root);
  const focusedId = useLayoutStore((s) => s.layout.focusedPaneId);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0">
      <RenderNode node={root} focusedId={focusedId} />
    </div>
  );
});

function RenderNode({
  node,
  focusedId,
}: {
  node: PaneNode;
  focusedId: string;
}) {
  if (node.type === "leaf") {
    return <PaneContainer leaf={node} isFocused={node.id === focusedId} />;
  }
  return <RenderSplit split={node} focusedId={focusedId} />;
}

function RenderSplit({
  split,
  focusedId,
}: {
  split: PaneSplit;
  focusedId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = split.direction === "h";
  const [firstSize, secondSize] = split.sizes;

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-full w-full min-h-0 min-w-0",
        isHorizontal ? "flex-row" : "flex-col",
      )}
    >
      <div
        className="min-h-0 min-w-0"
        style={
          isHorizontal
            ? { width: `${firstSize}%`, height: "100%" }
            : { height: `${firstSize}%`, width: "100%" }
        }
      >
        <RenderNode node={split.children[0]} focusedId={focusedId} />
      </div>
      <ResizeHandle
        splitId={split.id}
        direction={split.direction}
        containerRef={containerRef}
        initialSizes={split.sizes}
      />
      <div
        className="min-h-0 min-w-0"
        style={
          isHorizontal
            ? { width: `${secondSize}%`, height: "100%" }
            : { height: `${secondSize}%`, width: "100%" }
        }
      >
        <RenderNode node={split.children[1]} focusedId={focusedId} />
      </div>
    </div>
  );
}
