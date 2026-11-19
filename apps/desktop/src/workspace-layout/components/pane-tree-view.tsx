import { memo, useRef } from "react";
import { cn } from "@/lib/cn";
import { findLeaf } from "../lib/pane-tree";
import { useLayoutStore } from "../state/layout-store";
import type { PaneNode, PaneSplit } from "../types";
import { PaneContainer } from "./pane-container";
import { ResizeHandle } from "./resize-handle";

export const PaneTreeView = memo(function PaneTreeView() {
  const root = useLayoutStore((s) => s.layout.root);
  const focusedId = useLayoutStore((s) => s.layout.focusedPaneId);
  const maximized = useLayoutStore((s) => s.paneMaximized);

  return (
    <div className="flex h-full w-full min-h-0 min-w-0">
      <RenderNode node={root} focusedId={focusedId} maximized={maximized} />
    </div>
  );
});

interface RenderProps {
  focusedId: string;
  /** Focused pane fills the tree; siblings stay mounted but hidden. */
  maximized: boolean;
}

function RenderNode({ node, ...props }: RenderProps & { node: PaneNode }) {
  if (node.type === "leaf") {
    return <PaneContainer leaf={node} isFocused={node.id === props.focusedId} />;
  }
  return <RenderSplit split={node} {...props} />;
}

function RenderSplit({
  split,
  focusedId,
  maximized,
}: RenderProps & { split: PaneSplit }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = split.direction === "h";
  // Maximizing only changes sizes and visibility, never the tree shape, so
  // no pane remounts (editors, iframes and terminals keep their state).
  const focusedSide = maximized
    ? findLeaf(split.children[0], focusedId)
      ? 0
      : findLeaf(split.children[1], focusedId)
        ? 1
        : null
    : null;
  const [firstSize, secondSize]: [number, number] =
    focusedSide === 0 ? [100, 0] : focusedSide === 1 ? [0, 100] : split.sizes;

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-full w-full min-h-0 min-w-0",
        isHorizontal ? "flex-row" : "flex-col",
      )}
    >
      <div
        className={cn("min-h-0 min-w-0", focusedSide === 1 && "hidden")}
        style={
          isHorizontal
            ? { width: `${firstSize}%`, height: "100%" }
            : { height: `${firstSize}%`, width: "100%" }
        }
      >
        <RenderNode
          node={split.children[0]}
          focusedId={focusedId}
          maximized={maximized}
        />
      </div>
      {focusedSide === null ? (
        <ResizeHandle
          splitId={split.id}
          direction={split.direction}
          containerRef={containerRef}
          initialSizes={split.sizes}
        />
      ) : null}
      <div
        className={cn("min-h-0 min-w-0", focusedSide === 0 && "hidden")}
        style={
          isHorizontal
            ? { width: `${secondSize}%`, height: "100%" }
            : { height: `${secondSize}%`, width: "100%" }
        }
      >
        <RenderNode
          node={split.children[1]}
          focusedId={focusedId}
          maximized={maximized}
        />
      </div>
    </div>
  );
}
