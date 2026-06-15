import { AgentLogo } from "@/components/agent-logo";
import { cn } from "@/lib/cn";
import { useOptionalProjectTasks } from "@/session/context/project-tasks-context";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@chro/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Loader2,
  MessagesSquare,
  PinIcon,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useMemo,
} from "react";
import { useLayoutStore } from "../state/layout-store";
import type { PaneLeaf, PaneNode, Tab, TabKind } from "../types";
import { iconForKind, titleForTab } from "./tab-meta";

interface TabBarProps {
  leaf: PaneLeaf;
  isFocused: boolean;
}

export function TabBar({ leaf, isFocused }: TabBarProps) {
  const closeTab = useLayoutStore((s) => s.closeTab);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);
  const setFocusedPane = useLayoutStore((s) => s.setFocusedPane);

  return (
    <div
      data-tab-bar-leaf-id={leaf.id}
      className={cn(
        // Transparent strip sitting on the muted backdrop. `z-10` keeps the
        // active tab (and its flared feet) above the content card so it can
        // paint over the card's top border and merge into it. `pl-4` (16px)
        // keeps the first tab's 8px left foot clear of the card's 8px
        // rounded corner, so it always lands on the card's flat top edge.
        "relative z-10 flex h-9 shrink-0 items-stretch gap-1.5 overflow-x-auto pl-4",
        "scrollbar-thin",
      )}
      onMouseDown={() => setFocusedPane(leaf.id)}
    >
      {leaf.tabs.map((tab) => (
        <TabBarItem
          key={tab.id}
          tab={tab}
          leafId={leaf.id}
          isActive={tab.id === leaf.activeTabId}
          isFocused={isFocused}
          onActivate={() => setActiveTab(leaf.id, tab.id)}
          onClose={() => closeTab(tab.id)}
        />
      ))}
      <NewTabButton leafId={leaf.id} />
      <TabBarTrailingDropZone leafId={leaf.id} />
    </div>
  );
}

interface TabBarItemProps {
  tab: Tab;
  leafId: string;
  isActive: boolean;
  isFocused: boolean;
  onActivate: () => void;
  onClose: () => void;
}

function TabBarItem({
  tab,
  leafId,
  isActive,
  isFocused,
  onActivate,
  onClose,
}: TabBarItemProps) {
  const draggable = useDraggable({
    id: `tab:${tab.id}`,
    data: { kind: "tab", tabId: tab.id, leafId },
  });
  const droppable = useDroppable({
    id: `tab-drop:${tab.id}`,
    data: { kind: "tab-drop", leafId, beforeTabId: tab.id },
  });
  const Icon = useMemo(() => iconForKind(tab), [tab]);
  const title = useMemo(() => titleForTab(tab), [tab]);
  const isSessionTab = tab.kind.type === "session";
  const sessionAgent = useSessionTabAgent(tab);
  const isSessionRunning = useIsSessionTabRunning(tab);
  // For file tabs, the tooltip shows the worktree/project-relative path so
  // duplicates with the same basename can be told apart on hover. We do not
  // embed the worktree absolute prefix in the UI — the server is the only
  // place that knows the resolved root (see
  // `crates/server/src/routes/rpc/path_resolve.rs`).
  const tabTooltip = useMemo(() => {
    if (tab.kind.type === "file") return tab.kind.path;
    return title;
  }, [tab.kind, title]);

  const handleMouseDown = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  };

  const handleClose = (e: ReactMouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    onClose();
  };

  const handleCloseKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  const transformStyle: CSSProperties = draggable.transform
    ? {
        transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)`,
        zIndex: draggable.isDragging ? 30 : undefined,
        opacity: draggable.isDragging ? 0.85 : undefined,
      }
    : {};

  return (
    <div
      ref={droppable.setNodeRef}
      className={cn(
        "relative flex shrink-0",
        droppable.isOver &&
          "before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-primary",
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            ref={draggable.setNodeRef}
            type="button"
            onClick={onActivate}
            onMouseDown={handleMouseDown}
            style={transformStyle}
            {...draggable.attributes}
            {...draggable.listeners}
            className={cn(
              "group relative flex min-w-[120px] max-w-[220px] items-center gap-1.5 px-2.5 text-xs",
              "select-none",
              isActive
                ? "workspace-tab-active bg-background text-foreground"
                : "rounded-t-lg bg-transparent text-muted-foreground hover:bg-background/50",
            )}
            title={tabTooltip}
          >
            {/*
             * Blue active indicator along the tab's bottom edge. Sits inside
             * the side borders (inset-x-0 is relative to the padding box) and
             * over the seam where the tab merges into the content card.
             */}
            {isActive ? (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-primary" />
            ) : null}
            {isSessionTab ? (
              // Session tabs show the logo of the agent that actually ran the
              // session. Fresh sessions that have not run yet have no agent,
              // so they render no leading glyph (no generic chat icon).
              <AgentLogo
                agent={sessionAgent}
                className="h-3.5 w-3.5 shrink-0 opacity-90"
              />
            ) : Icon ? (
              <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
            ) : null}
            <span className="flex-1 truncate text-left">{title}</span>
            {tab.dirty ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/70" />
            ) : null}
            {isSessionRunning ? (
              <span
                className="inline-flex shrink-0 items-center text-custom-primary-100"
                aria-label="Session running"
              >
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              </span>
            ) : null}
            {tab.pinned ? (
              <PinIcon className="h-3 w-3 shrink-0 opacity-60" />
            ) : (
              <span
                role="button"
                tabIndex={-1}
                aria-label="Close tab"
                onClick={handleClose}
                onKeyDown={handleCloseKeyDown}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  "ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded",
                  "opacity-0 hover:bg-foreground/10 hover:opacity-100",
                  "group-hover:opacity-100",
                  isActive && "opacity-70",
                )}
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <TabContextMenuContent tab={tab} />
      </ContextMenu>
    </div>
  );
}

function TabContextMenuContent({ tab }: { tab: Tab }) {
  const closeTab = useLayoutStore((s) => s.closeTab);
  const closeOthers = useLayoutStore((s) => s.closeOthers);
  const closeToRight = useLayoutStore((s) => s.closeToRight);
  const splitWithTab = useLayoutStore((s) => s.splitWithTab);
  const patchTab = useLayoutStore((s) => s.patchTab);
  const root = useLayoutStore((s) => s.layout.root);
  const ownerLeafId = useMemo(() => {
    const stack: PaneNode[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "leaf") {
        if (node.tabs.some((t) => t.id === tab.id)) return node.id;
      } else {
        stack.push(node.children[0], node.children[1]);
      }
    }
    return null;
  }, [root, tab.id]);

  return (
    <ContextMenuContent className="w-52 text-xs">
      <ContextMenuItem onSelect={() => closeTab(tab.id)}>Close</ContextMenuItem>
      <ContextMenuItem onSelect={() => closeOthers(tab.id)}>
        Close Others
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => closeToRight(tab.id)}>
        Close to Right
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => patchTab(tab.id, { pinned: !tab.pinned })}
      >
        {tab.pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          if (ownerLeafId) splitWithTab(tab.id, ownerLeafId, "right");
        }}
      >
        Split Right
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          if (ownerLeafId) splitWithTab(tab.id, ownerLeafId, "bottom");
        }}
      >
        Split Down
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function TabBarTrailingDropZone({ leafId }: { leafId: string }) {
  const openTab = useLayoutStore((s) => s.openTab);
  const setFocusedPane = useLayoutStore((s) => s.setFocusedPane);
  const droppable = useDroppable({
    id: `tab-drop-end:${leafId}`,
    data: { kind: "tab-drop", leafId, beforeTabId: null },
  });

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // Only react to double-clicks on the empty space itself.
    if (event.target !== event.currentTarget) return;
    setFocusedPane(leafId);
    openTab({ type: "session" }, { targetLeafId: leafId, activate: true });
  };

  // Remaining space after the tabs + "+" button: a drop target for moving a
  // tab to the end and a double-click shortcut for opening a new session.
  return (
    <div
      ref={droppable.setNodeRef}
      className={cn(
        "flex flex-1 items-center",
        droppable.isOver && "bg-primary/10",
      )}
      onDoubleClick={handleDoubleClick}
    />
  );
}

function NewTabButton({ leafId }: { leafId: string }) {
  const openTab = useLayoutStore((s) => s.openTab);
  const setFocusedPane = useLayoutStore((s) => s.setFocusedPane);

  const open = (kind: TabKind) => {
    setFocusedPane(leafId);
    openTab(kind, { targetLeafId: leafId, activate: true });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="New tab"
          className={cn(
            "ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground",
            "hover:text-foreground data-[state=open]:text-foreground",
          )}
        >
          <Plus className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 text-xs">
        <DropdownMenuItem onSelect={() => open({ type: "session" })}>
          <MessagesSquare className="mr-2 h-3.5 w-3.5 opacity-70" />
          New session
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open({ type: "terminal" })}>
          <Terminal className="mr-2 h-3.5 w-3.5 opacity-70" />
          Terminal
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useIsSessionTabRunning(tab: Tab): boolean {
  const tasks = useOptionalProjectTasks();
  if (tab.kind.type !== "session") return false;
  const taskId = tab.kind.taskId;
  if (!taskId || !tasks) return false;
  return Boolean(tasks.taskByKey.get(taskId)?.active_session_id);
}

/**
 * Bare agent kind ("CLAUDE_CODE" / "CODEX") the session tab's task last ran
 * with, or null for non-session tabs and sessions that have not run yet.
 */
function useSessionTabAgent(tab: Tab): string | null {
  const tasks = useOptionalProjectTasks();
  if (tab.kind.type !== "session") return null;
  const taskId = tab.kind.taskId;
  if (!taskId || !tasks) return null;
  return tasks.taskByKey.get(taskId)?.last_executor ?? null;
}
