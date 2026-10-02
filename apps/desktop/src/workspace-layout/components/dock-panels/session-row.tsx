import type { TranslationFunction } from "@/i18n";
import { cn } from "@/lib/cn";
import type { ForkWorkspace } from "@/lib/fork-client";
import { SessionActivityIndicator } from "@/session/components/session-activity-indicator";
import { SessionLeadingMarker } from "@/session/components/session-leading-marker";
import { useSessionPreviewTrigger } from "@/session/components/session-preview";
import { useMarkViewedWhenActive, useTaskStatusDot } from "@/session/hooks";
import { formatRelativeTime } from "@/session/lib/relative-time";
import type { StoredTask } from "@/session/types";
import {
  SESSION_DRAG_DATA_TYPE,
  serializeSessionDragPayload,
} from "@/session/utils/session-dnd";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@chro/ui/context-menu";
import { Archive, GitBranch, Pin, PinOff } from "lucide-react";

/**
 * One session in the left panel. Shared by the Inbox list and the Map, where
 * a session sits under the directory it is addressed to, so a row reads the
 * same on both axes.
 */

export interface SessionRowContainerProps {
  task: StoredTask;
  indented: boolean;
  showProject: boolean;
  projectName: string | null;
  isPinned: boolean;
  onTogglePin: () => void;
  isActive: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onFork: (workspace?: ForkWorkspace) => void;
  /** Scratch chats have no repo, so there is no worktree to choose between and
   * the menu collapses to a single item. */
  canUseWorktree: boolean;
  t: TranslationFunction;
}

/**
 * Wraps a session row with its right-click menu (pin/unpin, archive). Open,
 * archive and active-state are resolved once per section by the caller and
 * passed in, so this stays a pure presentational wrapper.
 *
 * The trigger wraps `SessionRow` in a plain `<div>` rather than using
 * `asChild` directly on the component: Radix injects its ref and
 * `onContextMenu` onto the child element, and `SessionRow` (a component that
 * owns its own ref for hover-preview) would drop them, leaving right-click
 * dead. A real DOM node receives them cleanly.
 */
export function SessionRowContainer(props: SessionRowContainerProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <SessionRow
            task={props.task}
            indented={props.indented}
            showProject={props.showProject}
            projectName={props.projectName}
            isActive={props.isActive}
            isPinned={props.isPinned}
            onTogglePin={props.onTogglePin}
            onOpen={props.onOpen}
            onArchive={props.onArchive}
            t={props.t}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-20 w-44 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
        <ContextMenuItem
          onSelect={props.onTogglePin}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
        >
          {props.isPinned ? (
            <PinOff className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Pin className="h-3.5 w-3.5 shrink-0" />
          )}
          <span>
            {props.isPinned ? props.t("unpinSession") : props.t("pinSession")}
          </span>
        </ContextMenuItem>
        {/* Continuing from a session row has no anchor to pick, so it always
            branches from the latest finished run. The only open question is
            where the copy works, and only a repo can answer it. */}
        {props.canUseWorktree ? (
          <ContextMenuSub>
            <ContextMenuSubTrigger className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100">
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              <span>{props.t("continueIn")}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="z-20 w-52 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
              <ContextMenuItem
                onSelect={() => props.onFork("same")}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <span>{props.t("continueInNewSession")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => props.onFork("new_worktree")}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <span>{props.t("continueInNewWorktree")}</span>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        ) : (
          <ContextMenuItem
            onSelect={() => props.onFork()}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span>{props.t("continueInNewSession")}</span>
          </ContextMenuItem>
        )}
        <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
        <ContextMenuItem
          onSelect={props.onArchive}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
        >
          <Archive className="h-3.5 w-3.5 shrink-0" />
          <span>{props.t("archive")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface SessionRowProps {
  task: StoredTask;
  indented: boolean;
  showProject: boolean;
  projectName: string | null;
  isActive: boolean;
  isPinned: boolean;
  onTogglePin: () => void;
  onOpen: () => void;
  onArchive: () => void;
  t: TranslationFunction;
}

function SessionRow({
  task,
  indented,
  showProject,
  projectName,
  isActive,
  isPinned,
  onTogglePin,
  onOpen,
  onArchive,
  t,
}: SessionRowProps) {
  const isRunning = Boolean(task.active_session_id);
  const isAwaitingInput = Boolean(task.awaiting_input);
  const dotKind = useTaskStatusDot(task);
  useMarkViewedWhenActive(task, isActive);
  const preview = useSessionPreviewTrigger(task);
  return (
    <div
      ref={preview.setAnchor}
      role="option"
      aria-selected={isActive}
      tabIndex={0}
      draggable
      onClick={onOpen}
      onPointerEnter={preview.hoverProps.onPointerEnter}
      onPointerLeave={preview.hoverProps.onPointerLeave}
      onPointerDown={preview.hoverProps.onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
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
      className={cn(
        "group/row flex cursor-pointer items-center justify-between gap-2 rounded-md py-1.5 transition-colors",
        indented ? "pl-5 pr-2.5" : "px-2.5",
        isActive
          ? "bg-foreground/5 text-custom-sidebar-text-100"
          : "hover:bg-foreground/5",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="flex w-4 shrink-0 items-center justify-center">
          <SessionLeadingMarker kind={dotKind} t={t} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          {task.title ? (
            <span className="truncate text-sm text-custom-sidebar-text-100">
              {task.title}
            </span>
          ) : (
            <span className="truncate text-sm text-custom-sidebar-text-400">
              {t("sessionUnresolved")}
            </span>
          )}
          {/* One sub-line, one fact. The run outcome wins: it says what the
              session actually did, which no other row element carries.
              Provenance is next (a forked row is only legible if you can see
              what it continues; also the only signal before the first run),
              then the project name for pinned rows. */}
          {task.last_summary ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {task.last_summary}
            </span>
          ) : task.forked_from_title ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {t("forkedFrom", { title: task.forked_from_title })}
            </span>
          ) : task.delegated_from_title ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {t("delegatedFrom", { title: task.delegated_from_title })}
            </span>
          ) : showProject && projectName ? (
            <span className="truncate text-xs text-custom-sidebar-text-400">
              {projectName}
            </span>
          ) : null}
        </span>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        {isRunning ? (
          <span className="inline-flex items-center group-hover/row:hidden">
            <SessionActivityIndicator awaitingInput={isAwaitingInput} t={t} />
          </span>
        ) : (
          <span className="text-sm text-custom-sidebar-text-400 group-hover/row:hidden">
            {formatRelativeTime(task.updated_at)}
          </span>
        )}
        <span className="hidden items-center gap-1.5 group-hover/row:flex">
          <button
            type="button"
            aria-label={isPinned ? t("unpinSession") : t("pinSession")}
            title={isPinned ? t("unpinSession") : t("pinSession")}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
            className="flex items-center justify-center rounded p-0.5 text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100"
          >
            <Pin className={cn("h-3.5 w-3.5", isPinned && "fill-current")} />
          </button>
          <button
            type="button"
            aria-label="Archive session"
            onClick={(event) => {
              event.stopPropagation();
              onArchive();
            }}
            className="flex items-center justify-center rounded p-0.5 text-custom-sidebar-text-300 hover:bg-custom-sidebar-background-100 hover:text-custom-sidebar-text-100"
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        </span>
      </span>
    </div>
  );
}
