import {
  type CollisionDetection,
  DndContext,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { findLeaf } from "../lib/pane-tree";
import { useLayoutStore } from "../state/layout-store";
import type { DropEdge } from "../types";

interface PaneDndContextProps {
  children: ReactNode;
}

interface DragData {
  kind: "tab";
  tabId: string;
  leafId: string;
}

interface TabDropData {
  kind: "tab-drop";
  leafId: string;
  beforeTabId: string | null;
}

interface PaneBodyDropData {
  kind: "pane-body";
  leafId: string;
}

type DropData = TabDropData | PaneBodyDropData;

/**
 * Live drop preview state — updated on every pointer move during a tab drag
 * so a hovered pane can paint the resolved split region (left/right/top/
 * bottom/center) before the user releases. Without this the user has no
 * indication of where the dragged tab will land.
 */
interface PaneDropPreview {
  leafId: string;
  edge: DropEdge;
}

const PaneDropPreviewContext = createContext<PaneDropPreview | null>(null);

export function usePaneDropPreview(leafId: string): DropEdge | null {
  const preview = useContext(PaneDropPreviewContext);
  if (!preview || preview.leafId !== leafId) return null;
  return preview.edge;
}

/**
 * Top-level dnd-kit context wrapping the entire pane area. Translates
 * drag-end events into layout-store actions: reorder within a tab bar,
 * move to another leaf, or split a leaf when dropped near its edges.
 */
export function PaneDndContext({ children }: PaneDndContextProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const collisionDetection: CollisionDetection = useCallback(
    (args) => pointerWithin(args),
    [],
  );

  const [preview, setPreview] = useState<PaneDropPreview | null>(null);

  const updatePreview = useCallback(
    (event: DragMoveEvent | DragOverEvent | DragEndEvent) => {
      const { active, over } = event;
      const activeData = active.data.current as DragData | undefined;
      if (activeData?.kind !== "tab" || !over) {
        setPreview((prev) => (prev === null ? prev : null));
        return;
      }
      const overData = over.data.current as DropData | undefined;
      if (overData?.kind !== "pane-body") {
        setPreview((prev) => (prev === null ? prev : null));
        return;
      }
      const edge = resolvePaneEdge(event) ?? "center";
      setPreview((prev) =>
        prev && prev.leafId === overData.leafId && prev.edge === edge
          ? prev
          : { leafId: overData.leafId, edge },
      );
    },
    [],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setPreview(null);
      const { active, over } = event;
      if (!over) return;
      const activeData = active.data.current as DragData | undefined;
      if (activeData?.kind !== "tab") return;

      const overData = over.data.current as DropData | undefined;
      if (!overData?.leafId) return;

      if (overData.kind === "tab-drop") {
        handleTabDrop(activeData.tabId, overData);
        return;
      }

      if (overData.kind === "pane-body") {
        handlePaneBodyDrop(activeData.tabId, overData.leafId, event);
      }
    },
    [],
  );

  const onDragCancel = useCallback((_event: DragCancelEvent) => {
    setPreview(null);
  }, []);

  const previewValue = useMemo(() => preview, [preview]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragMove={updatePreview}
      onDragOver={updatePreview}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <PaneDropPreviewContext.Provider value={previewValue}>
        {children}
      </PaneDropPreviewContext.Provider>
    </DndContext>
  );
}

function handleTabDrop(tabId: string, target: TabDropData): void {
  const store = useLayoutStore.getState();
  const targetLeaf = findLeaf(store.layout.root, target.leafId);
  if (!targetLeaf) return;

  let insertIndex: number;
  if (target.beforeTabId == null) {
    insertIndex = targetLeaf.tabs.length;
  } else {
    const idx = targetLeaf.tabs.findIndex(
      (t) => t.id === target.beforeTabId,
    );
    insertIndex = idx === -1 ? targetLeaf.tabs.length : idx;
  }
  store.moveTab(tabId, { leafId: target.leafId, index: insertIndex });
}

function handlePaneBodyDrop(
  tabId: string,
  targetLeafId: string,
  event: DragEndEvent,
): void {
  const store = useLayoutStore.getState();
  const edge = resolvePaneEdge(event);
  if (edge === "center" || edge === null) {
    store.moveTab(tabId, { leafId: targetLeafId });
    return;
  }
  store.splitWithTab(tabId, targetLeafId, edge);
}

function resolvePaneEdge(
  event: DragEndEvent | DragMoveEvent | DragOverEvent,
): DropEdge | null {
  const over = event.over;
  if (!over?.rect) return null;
  const activator = event.activatorEvent as PointerEvent | undefined;
  if (!activator) return "center";
  const x = activator.clientX + event.delta.x;
  const y = activator.clientY + event.delta.y;
  return computeEdgeFromRect(over.rect, x, y);
}

function computeEdgeFromRect(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): DropEdge {
  const localX = x - rect.left;
  const localY = y - rect.top;
  const w = rect.width;
  const h = rect.height;
  const margin = 0.3;
  if (
    localX > w * margin &&
    localX < w * (1 - margin) &&
    localY > h * margin &&
    localY < h * (1 - margin)
  ) {
    return "center";
  }
  const distances: Array<[DropEdge, number]> = [
    ["left", localX],
    ["right", w - localX],
    ["top", localY],
    ["bottom", h - localY],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}
