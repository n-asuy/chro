
import type { TranslationFunction } from "@/i18n";
import { Archive, Loader2 } from "lucide-react";
import { useCallback, useRef } from "react";
import type { StoredTask } from "../types";
import {
  SESSION_DRAG_DATA_TYPE,
  serializeSessionDragPayload,
} from "../utils/session-dnd";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

const formatTime = (dateInput: Date | string) => {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
};

interface SessionListProps {
  tasks: StoredTask[];
  activeTaskId: string | null;
  onLoadTask: (task: StoredTask) => void;
  onArchiveTask?: (task: StoredTask) => void;
  t: TranslationFunction;
}

export function SessionList({
  tasks,
  activeTaskId,
  onLoadTask,
  onArchiveTask,
  t,
}: SessionListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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

      if (tasks.length === 0) return;

      const currentIndex = tasks.findIndex((task) => task.id === activeTaskId);
      const curIndex = currentIndex === -1 ? 0 : currentIndex;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = Math.min(tasks.length - 1, curIndex + 1);
          const nextTask = tasks[next];
          if (nextTask) {
            onLoadTask(nextTask);
            itemRefs.current
              .get(nextTask.id)
              ?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev = Math.max(0, curIndex - 1);
          const prevTask = tasks[prev];
          if (prevTask) {
            onLoadTask(prevTask);
            itemRefs.current
              .get(prevTask.id)
              ?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "Home": {
          e.preventDefault();
          const firstTask = tasks[0];
          if (firstTask) {
            onLoadTask(firstTask);
            itemRefs.current
              .get(firstTask.id)
              ?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "End": {
          e.preventDefault();
          const lastTask = tasks[tasks.length - 1];
          if (lastTask) {
            onLoadTask(lastTask);
            itemRefs.current
              .get(lastTask.id)
              ?.scrollIntoView({ block: "nearest" });
          }
          break;
        }
      }
    },
    [tasks, activeTaskId, onLoadTask],
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto outline-none"
      style={{ contain: "strict" }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={() => containerRef.current?.focus()}
      role="listbox"
    >
      <div className="px-3 py-4">
        {tasks.map((task) => {
          const isActiveTask = activeTaskId === task.id;
          const isRunningTask = Boolean(task.active_session_id);

          return (
            <div
              key={task.id}
              ref={(el) => {
                if (el) {
                  itemRefs.current.set(task.id, el);
                } else {
                  itemRefs.current.delete(task.id);
                }
              }}
              className="mb-1"
              role="option"
              aria-selected={isActiveTask}
            >
              <div
                className={cn(
                  "group flex items-center justify-between gap-2.5 w-full cursor-pointer rounded-[3px] px-2.5 py-1.5",
                  isActiveTask
                    ? "bg-custom-sidebar-background-80"
                    : "bg-custom-sidebar-background-90 hover:bg-custom-sidebar-background-80",
                )}
                draggable
                onClick={() => onLoadTask(task)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData(
                    SESSION_DRAG_DATA_TYPE,
                    serializeSessionDragPayload({
                      taskId: task.id,
                      branch: task.branch ?? null,
                    }),
                  );
                  event.dataTransfer.setData(
                    "text/plain",
                    task.title?.trim() || task.id.slice(0, 8),
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onLoadTask(task);
                  }
                }}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  {task.title ? (
                    <span className="truncate text-sm text-foreground">
                      {task.title}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t("sessionUnresolved")}
                    </span>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {isRunningTask ? (
                    <span
                      className="inline-flex items-center text-custom-primary-100"
                      aria-label={t("waitingMessage")}
                    >
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    </span>
                  ) : (
                    <>
                      <span className="text-sm text-[#B3B3B3] dark:text-[#777777] group-hover:hidden">
                        {formatTime(task.updated_at)}
                      </span>
                      {onArchiveTask ? (
                        <button
                          className="hidden group-hover:flex items-center justify-center p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          aria-label="Archive session"
                          onClick={(e) => {
                            e.stopPropagation();
                            onArchiveTask(task);
                          }}
                        >
                          <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
