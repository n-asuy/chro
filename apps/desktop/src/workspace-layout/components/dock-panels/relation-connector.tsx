import { type RefObject, useLayoutEffect, useState } from "react";

/** Where a branch meets a row: just before its leading status marker. */
export type ConnectorNode = { x: number; y: number };

type ConnectorGeometry = { d: string; height: number };

/** Spine position inside the list's left gutter, in list coordinates. */
const SPINE_X = 4;
const BEND_RADIUS = 6;
/** Space left between a branch's end and the row's status marker. */
const MARKER_GAP = 3;

const ROW_SELECTOR = '[role="option"][data-related]';
const MARKER_SELECTOR = "[data-row-marker]";

/**
 * SVG path joining rows with one vertical spine: it bends into the topmost
 * and bottommost rows and branches straight into every row between them, the
 * way a tree view draws its guides.
 */
export function connectorPath(
  nodes: readonly ConnectorNode[],
  { spineX, radius }: { spineX: number; radius: number },
): string {
  if (nodes.length < 2) return "";
  const sorted = [...nodes].sort((a, b) => a.y - b.y);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const r = Math.min(radius, (last.y - first.y) / 2);
  const spine = [
    `M ${first.x} ${first.y} H ${spineX + r} Q ${spineX} ${first.y} ${spineX} ${first.y + r}`,
    `V ${last.y - r} Q ${spineX} ${last.y} ${spineX + r} ${last.y} H ${last.x}`,
  ];
  const branches = sorted
    .slice(1, -1)
    .map((node) => `M ${spineX} ${node.y} H ${node.x}`);
  return [...spine, ...branches].join(" ");
}

function measure(container: HTMLElement): ConnectorGeometry | null {
  const box = container.getBoundingClientRect();
  const nodes: ConnectorNode[] = [];
  for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const anchor = row.querySelector<HTMLElement>(MARKER_SELECTOR) ?? row;
    const rect = anchor.getBoundingClientRect();
    // Rows inside a collapsing section have no box yet (or any more).
    if (rect.height === 0) continue;
    nodes.push({
      x: Math.round(rect.left - box.left - MARKER_GAP),
      y: Math.round(rect.top - box.top + container.scrollTop + rect.height / 2),
    });
  }
  if (nodes.length < 2) return null;
  return {
    d: connectorPath(nodes, { spineX: SPINE_X, radius: BEND_RADIUS }),
    height: container.scrollHeight,
  };
}

/**
 * Draws the focused session's relation group (rows marked `data-related`) as
 * one connected line in the list's left gutter, so related sessions read as
 * linked wherever they sit in the list. Mount it inside the scroll container,
 * which must be `relative`: the line is laid out in content coordinates and
 * scrolls with the rows.
 */
export function RelationConnector({
  containerRef,
  enabled,
}: {
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
}) {
  const [geometry, setGeometry] = useState<ConnectorGeometry | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) {
      setGeometry(null);
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measure(container);
        setGeometry((prev) =>
          prev?.d === next?.d && prev?.height === next?.height ? prev : next,
        );
      });
    };
    setGeometry(measure(container));

    // Rows mount, unmount, fold and change group as the stream updates;
    // section reveals animate them into place.
    const mutations = new MutationObserver(update);
    mutations.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-related", "aria-selected"],
    });
    const resizes = new ResizeObserver(update);
    resizes.observe(container);
    container.addEventListener("animationend", update);
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resizes.disconnect();
      container.removeEventListener("animationend", update);
    };
  }, [containerRef, enabled]);

  if (!geometry) return null;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 w-full overflow-visible"
      style={{ height: geometry.height }}
    >
      <path
        d={geometry.d}
        fill="none"
        strokeWidth={1.25}
        strokeLinecap="round"
        className="stroke-primary/60"
      />
    </svg>
  );
}
