import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
import { useWorkspaceBoardContext } from "@/kanban/providers";
import type { BoardColumn, BoardIssue } from "@/kanban/types";
import { cn } from "@/lib/cn";

import {
  AddTaskPanel,
  type AddTaskPayload,
  type AddTaskSubmitOptions,
} from "./add-task-panel";
import { KanbanColumnIcon } from "./column-icon";
import { getColumnIconVariant } from "./column-icon-variants";
import { KanbanIssueCard } from "./issue-card";
import { KanbanIssueBlockLoader } from "./kanban-issue-block-loader";

interface KanbanColumnProps {
  column: BoardColumn;
  issues: BoardIssue[];
  visibleIssueIds: string[];
  isPaginating: boolean;
  canLoadMore: boolean;
  onLoadMore: () => void;
  dropPreview?: {
    targetIssueId?: string;
    isColumnTarget: boolean;
    insertAfter?: boolean;
  } | null;
}

const DropIndicator = () => (
  <div className="pointer-events-none mx-2 mb-2 mt-1 h-0.5 rounded-full bg-custom-primary-100 shadow-[0_0_8px_rgba(14,116,144,0.55)]" />
);

const KanbanDraggableIssue: React.FC<{
  issue: BoardIssue;
  columnId: string;
  index: number;
  itemRef?: (el: HTMLDivElement | null) => void;
}> = ({ issue, columnId, index, itemRef }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: issue.id,
    data: {
      type: "issue",
      columnId,
      index,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        itemRef?.(node);
      }}
      style={style}
      {...attributes}
      {...listeners}
    >
      <KanbanIssueCard issue={issue} isDragging={isDragging} />
    </div>
  );
};

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  column,
  issues,
  visibleIssueIds,
  isPaginating,
  canLoadMore,
  onLoadMore,
  dropPreview,
}) => {
  const totalCount = column.issues.length;
  const columnRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [intersectionElement, setIntersectionElement] =
    useState<HTMLSpanElement | null>(null);
  const [addTaskOrigin, setAddTaskOrigin] = useState<
    "header" | "footer" | null
  >(null);
  const isAddTaskOpen = addTaskOrigin !== null;

  const {
    addIssueToColumn,
    peekIssueId,
    setPeekIssue,
    deleteArchivedIssues,
    projectId,
  } = useWorkspaceBoardContext();

  const normalizedColumnKey = useMemo(() => {
    const key = (column.id || column.title)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");
    return key;
  }, [column.id, column.title]);

  const isArchivedColumn = normalizedColumnKey === "archived";
  const isDoneColumn = normalizedColumnKey === "done";

  const canShowAddButton = useMemo(() => {
    return !isArchivedColumn && !isDoneColumn;
  }, [isArchivedColumn, isDoneColumn]);

  const handleDeleteAllArchived = useCallback(() => {
    if (totalCount === 0) return;
    void deleteArchivedIssues();
  }, [deleteArchivedIssues, totalCount]);

  const issuePositions = useMemo(() => {
    const map = new Map<string, number>();
    column.issues.forEach((issue, index) => {
      map.set(issue.id, index);
    });
    return map;
  }, [column.issues]);

  const filteredIssueMap = useMemo(() => {
    const map = new Map<string, BoardIssue>();
    for (const issue of issues) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const displayedIssues = useMemo(() => {
    const orderedIssues: BoardIssue[] = [];
    for (const id of visibleIssueIds) {
      const match = filteredIssueMap.get(id);
      if (match) orderedIssues.push(match);
    }
    return orderedIssues;
  }, [filteredIssueMap, visibleIssueIds]);

  useIntersectionObserver(
    columnRef,
    isPaginating ? null : intersectionElement,
    onLoadMore,
    "0% 100% 100% 100%",
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      if (displayedIssues.length === 0) return;

      const currentIndex = displayedIssues.findIndex(
        (issue) => issue.id === peekIssueId,
      );
      const curIndex = currentIndex === -1 ? -1 : currentIndex;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next =
            curIndex === -1
              ? 0
              : Math.min(displayedIssues.length - 1, curIndex + 1);
          const nextIssue = displayedIssues[next];
          if (nextIssue) {
            setPeekIssue(nextIssue.id);
            itemRefs.current
              .get(nextIssue.id)
              ?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev =
            curIndex === -1
              ? displayedIssues.length - 1
              : Math.max(0, curIndex - 1);
          const prevIssue = displayedIssues[prev];
          if (prevIssue) {
            setPeekIssue(prevIssue.id);
            itemRefs.current
              .get(prevIssue.id)
              ?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "Home": {
          e.preventDefault();
          const firstIssue = displayedIssues[0];
          if (firstIssue) {
            setPeekIssue(firstIssue.id);
            itemRefs.current
              .get(firstIssue.id)
              ?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "End": {
          e.preventDefault();
          const lastIssue = displayedIssues[displayedIssues.length - 1];
          if (lastIssue) {
            setPeekIssue(lastIssue.id);
            itemRefs.current
              .get(lastIssue.id)
              ?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "Escape": {
          e.preventDefault();
          setPeekIssue(undefined);
          break;
        }
      }
    },
    [displayedIssues, peekIssueId, setPeekIssue],
  );

  const handleAddTask = (payload: AddTaskPayload, options?: AddTaskSubmitOptions) => {
    addIssueToColumn(column.id, payload.title, {
      summary: payload.summary,
      prompt: payload.prompt,
      runImmediately: options?.runImmediately,
      useWorktree: options?.useWorktree,
      executorProfileId: options?.executorProfileId,
      targetBranch: options?.targetBranch,
    });
  };

  const loadMoreMarker = canLoadMore ? (
    isPaginating ? (
      <KanbanIssueBlockLoader />
    ) : (
      <KanbanIssueBlockLoader ref={setIntersectionElement} />
    )
  ) : null;

  const { setNodeRef, isOver } = useDroppable({
    id: `column-${column.id}`,
    data: {
      type: "column",
      columnId: column.id,
    },
  });

  const handleColumnRef = (node: HTMLDivElement | null) => {
    columnRef.current = node;
    setNodeRef(node);
  };

  const shouldHighlight = isOver || Boolean(dropPreview);
  // Show terminal indicator when:
  // 1. Column is the target and no specific issue is targeted (empty column drop)
  // 2. Last item is targeted with insertAfter (insert at end)
  const lastIssueId = displayedIssues[displayedIssues.length - 1]?.id;
  const shouldShowTerminalIndicator = Boolean(
    (dropPreview?.isColumnTarget && !dropPreview?.targetIssueId) ||
      (dropPreview?.targetIssueId === lastIssueId && dropPreview?.insertAfter),
  );

  return (
    <div className="group relative flex w-[350px] flex-shrink-0 flex-col rounded-lg bg-custom-background-90 font-workspace text-[12px] leading-[1.35]">
      <div className="sticky top-0 z-[2] w-full flex-shrink-0 rounded-t-lg bg-custom-background-90 py-1">
        <div className="relative flex items-center gap-2 p-1.5">
          {addTaskOrigin === "header" && (
            <AddTaskPanel
              isOpen
              onClose={() => setAddTaskOrigin(null)}
              onSubmit={handleAddTask}
              projectId={projectId}
              placement="bottom"
            />
          )}
          <KanbanColumnIcon
            aria-hidden
            variant={getColumnIconVariant(column)}
            className="h-5 w-5 text-custom-text-350"
          />
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="line-clamp-1 text-[13px] font-semibold text-custom-text-100">
                {column.title}
              </p>
              <span className="text-[11px] font-medium text-custom-text-300">
                {totalCount}
              </span>
            </div>
            {canShowAddButton && (
              <TooltipProvider delayDuration={120}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-5 w-5 items-center justify-center rounded text-custom-text-350 hover:bg-custom-background-80 hover:text-custom-text-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-custom-primary-100"
                      onClick={() => setAddTaskOrigin("header")}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    Add Task
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {isArchivedColumn && totalCount > 0 && (
              <TooltipProvider delayDuration={120}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-5 w-5 items-center justify-center rounded text-custom-text-350 hover:bg-rose-100 dark:hover:bg-rose-950/50 hover:text-rose-600 dark:hover:text-rose-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400 dark:focus-visible:ring-rose-600"
                      onClick={handleDeleteAllArchived}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    Delete All
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      </div>
      <div
        ref={(node) => {
          handleColumnRef(node);
          containerRef.current = node;
        }}
        className={cn(
          "vertical-scrollbar scrollbar-md relative h-full min-h-[120px] overflow-y-auto px-1.5 pb-12 outline-none transition",
          {
            "bg-custom-background-80/40": shouldHighlight,
            "ring-1 ring-custom-primary-100/40": shouldHighlight,
          },
        )}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onClick={() => containerRef.current?.focus()}
        role="listbox"
      >
        <SortableContext
          items={displayedIssues.map((issue) => issue.id)}
          strategy={verticalListSortingStrategy}
        >
          {displayedIssues.flatMap((issue, idx) => {
            const blocks: ReactNode[] = [];
            const isTarget = dropPreview?.targetIssueId === issue.id;
            // Show indicator before if this is the target and insertAfter is false
            if (isTarget && !dropPreview?.insertAfter) {
              blocks.push(
                <DropIndicator key={`indicator-before-${issue.id}`} />,
              );
            }
            blocks.push(
              <KanbanDraggableIssue
                key={issue.id}
                issue={issue}
                columnId={column.id}
                index={issuePositions.get(issue.id) ?? 0}
                itemRef={(el) => {
                  if (el) {
                    itemRefs.current.set(issue.id, el);
                  } else {
                    itemRefs.current.delete(issue.id);
                  }
                }}
              />,
            );
            // Show indicator after if this is the target and insertAfter is true
            // But only if it's not the last item (terminal indicator handles that)
            if (
              isTarget &&
              dropPreview?.insertAfter &&
              idx < displayedIssues.length - 1
            ) {
              blocks.push(
                <DropIndicator key={`indicator-after-${issue.id}`} />,
              );
            }
            return blocks;
          })}
        </SortableContext>
        {shouldShowTerminalIndicator && (
          <DropIndicator key="indicator-terminal" />
        )}
        {displayedIssues.length === 0 && !loadMoreMarker && (
          <div className="mt-2 flex h-24 items-center justify-center rounded border border-dashed border-custom-border-200 text-xs text-custom-text-400">
            Drop issues here
          </div>
        )}
        {loadMoreMarker}
      </div>
      {canShowAddButton && (
        <div className="relative w-full flex-shrink-0 rounded-b-lg bg-custom-background-90 py-0.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-[12px] font-medium text-custom-text-350 hover:text-custom-text-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-custom-primary-100 focus-visible:ring-offset-2 focus-visible:ring-offset-custom-background-100"
            onClick={() => setAddTaskOrigin("footer")}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Task</span>
          </button>
          {addTaskOrigin === "footer" && (
            <AddTaskPanel
              isOpen
              onClose={() => setAddTaskOrigin(null)}
              onSubmit={handleAddTask}
              projectId={projectId}
              placement="top"
            />
          )}
        </div>
      )}
    </div>
  );
};
