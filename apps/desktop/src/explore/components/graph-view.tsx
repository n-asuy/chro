import { useNavigate, useParams } from "@tanstack/react-router";
import { RotateCcw, Type } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, GraphNode } from "../types";

type ForceGraphInstance = {
  zoomToFit: (ms?: number, padding?: number) => void;
};

type NodeObject = GraphNode & { x?: number; y?: number };

type LinkObject = {
  source: string | NodeObject;
  target: string | NodeObject;
  strength?: number;
  type?: string;
};

function getNodeId(ref: string | NodeObject): string {
  return typeof ref === "object" ? ref.id : ref;
}

/** Read a CSS custom property value (R, G, B triplet) and return `rgb(...)` */
function readCssRgb(el: HTMLElement, prop: string): string | null {
  const raw = getComputedStyle(el).getPropertyValue(prop).trim();
  if (!raw) return null;
  return `rgb(${raw})`;
}

interface GraphViewProps {
  graphData: GraphData;
}

export function GraphView({ graphData }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphInstance | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [showLabels, setShowLabels] = useState(true);
  const [hoveredNode, setHoveredNode] = useState<NodeObject | null>(null);
  const [palette, setPalette] = useState({
    bg: "#191919",
    accent: "rgb(40,146,204)",
    tag: "rgb(163,163,163)",
    text: "rgba(229,229,229,0.8)",
    textDim: "rgba(115,115,115,0.6)",
    link: "rgba(115,115,115,0.2)",
    linkHi: "rgba(163,163,163,0.7)",
    linkDim: "rgba(82,82,82,0.06)",
  });
  const [ForceGraph2D, setForceGraph2D] = useState<React.ComponentType<
    Record<string, unknown>
  > | null>(null);

  const navigate = useNavigate();
  const { projectId } = useParams({ strict: false }) as {
    projectId?: string;
  };

  useEffect(() => {
    let cancelled = false;
    import("react-force-graph-2d").then((mod) => {
      if (!cancelled) setForceGraph2D(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive palette from CSS custom properties
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const bg = readCssRgb(el, "--color-background-100") ?? "#191919";
    const accent = readCssRgb(el, "--color-primary-100") ?? palette.accent;
    const t100 = readCssRgb(el, "--color-text-100");
    const t200 = readCssRgb(el, "--color-text-200");
    const t300 = readCssRgb(el, "--color-text-300");
    const t400 = readCssRgb(el, "--color-text-400");
    setPalette({
      bg,
      accent,
      tag: t200 ?? palette.tag,
      text: t100
        ? `${t100.slice(0, -1)},0.85)`.replace("rgb", "rgba")
        : palette.text,
      textDim: t300
        ? `${t300.slice(0, -1)},0.5)`.replace("rgb", "rgba")
        : palette.textDim,
      link: t300
        ? `${t300.slice(0, -1)},0.2)`.replace("rgb", "rgba")
        : palette.link,
      linkHi: t200
        ? `${t200.slice(0, -1)},0.7)`.replace("rgb", "rgba")
        : palette.linkHi,
      linkDim: t400
        ? `${t400.slice(0, -1)},0.06)`.replace("rgb", "rgba")
        : palette.linkDim,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setDimensions({ width, height });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const neighborMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const node of graphData.nodes) map.set(node.id, new Set());
    for (const link of graphData.links) {
      map.get(link.source)?.add(link.target);
      map.get(link.target)?.add(link.source);
    }
    return map;
  }, [graphData]);

  const highlightNeighbors = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    return neighborMap.get(hoveredNode.id) ?? new Set<string>();
  }, [hoveredNode, neighborMap]);

  const highlightLinkSet = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    const set = new Set<string>();
    const neighbors = neighborMap.get(hoveredNode.id);
    if (neighbors) {
      for (const n of neighbors) {
        set.add(`${hoveredNode.id}\0${n}`);
        set.add(`${n}\0${hoveredNode.id}`);
      }
    }
    return set;
  }, [hoveredNode, neighborMap]);

  const isLinkHighlighted = useCallback(
    (link: LinkObject) => {
      const s = getNodeId(link.source);
      const t = getNodeId(link.target);
      return highlightLinkSet.has(`${s}\0${t}`);
    },
    [highlightLinkSet],
  );

  const handleNodeClick = useCallback(
    (node: NodeObject) => {
      if (node.type === "note" && projectId) {
        void navigate({
          to: "/projects/$projectId/files",
          params: { projectId },
          search: { path: node.relativePath },
        });
      }
    },
    [navigate, projectId],
  );

  const nodeCanvasObject = useCallback(
    (node: NodeObject, ctx: CanvasRenderingContext2D, globalScale: number) => {
      if (node.x == null || node.y == null) return;

      const isHovered = hoveredNode?.id === node.id;
      const isNeighbor = hoveredNode != null && highlightNeighbors.has(node.id);
      const isDimmed = hoveredNode != null && !isHovered && !isNeighbor;

      const connections = node.backlinkCount || 0;
      const baseR = 4 + Math.log2(1 + connections) * 2;
      const r = isHovered ? baseR * 1.3 : baseR;

      ctx.globalAlpha = isDimmed ? 0.12 : 1.0;
      const color = node.type === "tag" ? palette.tag : palette.accent;

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      const shouldLabel = showLabels || isHovered;
      if (shouldLabel && globalScale > 0.4) {
        const fontSize = Math.min(14 / globalScale, 6);
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        const label = node.title;
        const labelY = node.y + r + 2;

        if (isHovered) {
          const tw = ctx.measureText(label).width;
          const pad = 3;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = palette.bg;
          ctx.fillRect(
            node.x - tw / 2 - pad,
            labelY - 1,
            tw + pad * 2,
            fontSize + 3,
          );
          ctx.globalAlpha = 1;
          ctx.fillStyle = palette.text;
        } else {
          ctx.globalAlpha = isDimmed ? 0.1 : 0.6;
          ctx.fillStyle = isDimmed ? palette.textDim : palette.text;
        }

        ctx.fillText(label, node.x, labelY);
      }

      ctx.globalAlpha = 1;
    },
    [hoveredNode, highlightNeighbors, showLabels, palette],
  );

  const linkColorFn = useCallback(
    (link: LinkObject) => {
      if (!hoveredNode) return palette.link;
      return isLinkHighlighted(link) ? palette.linkHi : palette.linkDim;
    },
    [hoveredNode, isLinkHighlighted, palette],
  );

  const linkWidthFn = useCallback(
    (link: LinkObject) => {
      const base = 0.8 + Math.log(link.strength ?? 1) * 0.3;
      if (!hoveredNode) return base;
      return isLinkHighlighted(link) ? base * 2.5 : base;
    },
    [hoveredNode, isLinkHighlighted],
  );

  if (!ForceGraph2D) {
    return (
      <div
        ref={containerRef}
        className="flex-1 flex items-center justify-center"
      >
        <span className="text-custom-text-400 text-sm">Loading graph...</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden">
      <ForceGraph2D
        ref={graphRef}
        width={dimensions.width}
        height={dimensions.height}
        graphData={graphData}
        nodeId="id"
        nodeLabel=""
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(
          node: NodeObject,
          color: string,
          ctx: CanvasRenderingContext2D,
        ) => {
          if (node.x == null || node.y == null) return;
          const r = 4 + Math.log2(1 + (node.backlinkCount || 0)) * 2 + 3;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
          ctx.fill();
        }}
        linkColor={linkColorFn}
        linkWidth={linkWidthFn}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        onNodeClick={handleNodeClick}
        onNodeHover={(node: NodeObject | null) => setHoveredNode(node)}
        backgroundColor={palette.bg}
        cooldownTime={4000}
        warmupTicks={50}
        onEngineStop={() => graphRef.current?.zoomToFit(0, 60)}
      />

      <div className="absolute top-3 right-3 flex flex-col gap-1.5 z-10">
        <button
          type="button"
          onClick={() => graphRef.current?.zoomToFit(0, 60)}
          className="rounded border border-custom-border-200 bg-custom-background-90/90 p-2 text-custom-text-200 hover:bg-custom-background-80"
          title="Reset view"
        >
          <RotateCcw size={14} />
        </button>
        <button
          type="button"
          onClick={() => setShowLabels((v) => !v)}
          className={`rounded border bg-custom-background-90/90 p-2 ${
            showLabels
              ? "text-custom-text-100 border-custom-border-100"
              : "text-custom-text-400 border-custom-border-200"
          }`}
          title="Toggle labels"
        >
          <Type size={14} />
        </button>
      </div>

      <div className="absolute bottom-3 right-3 flex gap-3 text-[11px] text-custom-text-400 z-10 bg-custom-background-90/80 px-2.5 py-1.5 rounded border border-custom-border-200">
        <span>{graphData.nodes.length} nodes</span>
        <span>{graphData.links.length} links</span>
      </div>

      {hoveredNode && (
        <div className="show-scrollbar absolute bottom-3 left-3 z-10 max-h-[min(40vh,320px)] max-w-[300px] overflow-y-auto rounded border border-custom-border-200 bg-custom-background-90/95 px-3 py-2">
          <div className="text-sm text-custom-text-100 font-medium truncate">
            {hoveredNode.title}
          </div>
          {hoveredNode.tags && hoveredNode.tags.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {hoveredNode.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] text-custom-primary-100 bg-custom-primary-100/10 px-1.5 py-0.5 rounded"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
          <div className="text-[11px] text-custom-text-400 mt-1">
            {hoveredNode.backlinkCount} backlink
            {hoveredNode.backlinkCount !== 1 ? "s" : ""}
          </div>
        </div>
      )}
    </div>
  );
}
