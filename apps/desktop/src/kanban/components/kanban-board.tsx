
import { useMemo, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { BoardFilters, BoardIssue } from "@/kanban/types";
import { useWorkspaceBoardContext } from "@/kanban/providers";
import { cn } from "@/lib/cn";
import { KanbanColumn } from "./kanban-column";
import { KanbanIssueCard } from "./issue-card";

const matchesFilters = (issue: BoardIssue, filters: BoardFilters) => {
  const stateMatch =
    filters.state.length === 0 || filters.state.includes(issue.state.id);
  const priorityMatch =
    filters.priority.length === 0 || filters.priority.includes(issue.priority);
  const labelMatch =
    filters.labels.length === 0 ||
    issue.labels.some((label) => filters.labels.includes(label.id));

  return stateMatch && priorityMatch && labelMatch;
};

type DropPreview = {
  columnId: string;
  targetIssueId?: string;
  isColumnTarget: boolean;
  insertAfter?: boolean;
};

export const KanbanBoard = () => {
  const {
    columns,
    filters,
    columnVisibleIssueIds,
    isColumnPaginating,
    loadMoreIssues,
    moveIssue,
    peekIssueId,
  } = useWorkspaceBoardContext();

  const mappedColumns = useMemo(
    () =>
      columns.map((column) => ({
        ...column,
        visibleIssues: column.issues.filter((issue) =>
          matchesFilters(issue, filters),
        ),
        visibleIssueIds: columnVisibleIssueIds[column.id] ?? [],
        isPaginating: isColumnPaginating[column.id] ?? false,
      })),
    [columns, filters, columnVisibleIssueIds, isColumnPaginating],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);

  const activeIssue: BoardIssue | undefined = useMemo(() => {
    if (!activeIssueId) return undefined;
    for (const column of columns) {
      const match = column.issues.find((issue) => issue.id === activeIssueId);
      if (match) return match;
    }
    return undefined;
  }, [activeIssueId, columns]);

  const handleDragStart = (event: DragStartEvent) => {
    if (event.active.data.current?.type !== "issue") return;
    setActiveIssueId(event.active.id.toString());
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const currentDropPreview = dropPreview;
    setActiveIssueId(null);
    setDropPreview(null);
    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.type !== "issue") return;

    const sourceColumnId: string = activeData.columnId;
    let targetColumnId: string | undefined;
    let targetIndex: number | undefined;

    if (overData?.type === "issue") {
      targetColumnId = overData.columnId;
      const baseIndex = overData.index as number;
      // Use insertAfter from dropPreview to determine the correct target index
      targetIndex = currentDropPreview?.insertAfter ? baseIndex + 1 : baseIndex;
    } else if (overData?.type === "column") {
      targetColumnId = overData.columnId;
      targetIndex = undefined;
    } else {
      return;
    }

    if (!targetColumnId) return;

    // Adjust targetIndex when moving within the same column
    // If the source is above the target, we need to account for the removal
    if (sourceColumnId === targetColumnId && targetIndex !== undefined) {
      const sourceIndex = activeData.index as number;
      if (sourceIndex < targetIndex) {
        targetIndex -= 1;
      }
      // Skip if moving to the same position
      if (targetIndex === sourceIndex) {
        return;
      }
    }

    moveIssue({
      issueId: active.id.toString(),
      sourceColumnId,
      targetColumnId,
      targetIndex,
    });
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over, active } = event;
    if (!over || active.data.current?.type !== "issue") {
      setDropPreview(null);
      return;
    }

    const overData = over.data.current;

    if (overData?.type === "issue") {
      // Determine whether to insert before or after based on drag position
      const overRect = over.rect;
      // Get the center Y of the dragged element's current position
      const activeRect = active.rect.current.translated;
      const activeCenterY = activeRect
        ? activeRect.top + activeRect.height / 2
        : overRect.top + overRect.height / 2;
      const overCenterY = overRect.top + overRect.height / 2;
      const insertAfter = activeCenterY > overCenterY;

      setDropPreview({
        columnId: overData.columnId,
        targetIssueId: over.id.toString(),
        isColumnTarget: false,
        insertAfter,
      });
      return;
    }

    if (overData?.type === "column") {
      setDropPreview({
        columnId: overData.columnId,
        targetIssueId: undefined,
        isColumnTarget: true,
      });
      return;
    }

    setDropPreview(null);
  };

  const handleDragCancel = () => {
    setActiveIssueId(null);
    setDropPreview(null);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragCancel={handleDragCancel}
    >
      <div className="horizontal-scrollbar scrollbar-lg relative flex h-full w-full bg-custom-background-100 overflow-x-auto overflow-y-hidden font-workspace text-[12px] leading-[1.35]">
        <div className="relative h-full w-max min-w-full bg-custom-background-100">
          <div className="h-full w-max">
            <div
              className={cn(
                "flex h-full w-max gap-2 px-2 py-4",
                peekIssueId && "pr-[50vw]",
              )}
            >
              {mappedColumns.map((column) => (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  issues={column.visibleIssues}
                  visibleIssueIds={column.visibleIssueIds}
                  isPaginating={column.isPaginating}
                  canLoadMore={
                    column.visibleIssueIds.length < column.issues.length
                  }
                  onLoadMore={() => loadMoreIssues(column.id)}
                  dropPreview={
                    dropPreview?.columnId === column.id
                      ? {
                          targetIssueId: dropPreview.targetIssueId,
                          isColumnTarget: dropPreview.isColumnTarget,
                          insertAfter: dropPreview.insertAfter,
                        }
                      : null
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeIssue ? <KanbanIssueCard issue={activeIssue} isOverlay /> : null}
      </DragOverlay>
    </DndContext>
  );
};
