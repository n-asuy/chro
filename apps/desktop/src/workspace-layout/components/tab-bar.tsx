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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Globe,
  Loader2,
  MessagesSquare,
  MonitorPlay,
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
import { WORKSPACE_LEADER_SHORTCUTS } from "../lib/keyboard-shortcuts";
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
        "flex h-9 shrink-0 items-stretch gap-px overflow-x-auto bg-muted/30",
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
                ? "bg-background text-foreground after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary"
                : "bg-transparent text-muted-foreground hover:bg-background/60",
            )}
            title={tabTooltip}
          >
            {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" /> : null}
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
    // Only react to double-clicks on the empty space itself, not the
    // "+" button (or any other child) sitting inside it.
    if (event.target !== event.currentTarget) return;
    setFocusedPane(leafId);
    openTab({ type: "session" }, { targetLeafId: leafId, activate: true });
  };

  return (
    <div
      ref={droppable.setNodeRef}
      className={cn(
        "flex flex-1 items-center pl-1 pr-1",
        droppable.isOver && "bg-primary/10",
      )}
      onDoubleClick={handleDoubleClick}
    >
      <NewTabMenu leafId={leafId} />
    </div>
  );
}

function NewTabMenu({ leafId }: { leafId: string }) {
  const openTab = useLayoutStore((s) => s.openTab);
  const setFocusedPane = useLayoutStore((s) => s.setFocusedPane);

  const open = (kind: TabKind) => {
    setFocusedPane(leafId);
    openTab(kind, { targetLeafId: leafId, activate: true });
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="New tab"
          className={cn(
            "ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground",
            "hover:text-foreground",
          )}
        >
          <Plus className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-72 rounded-lg p-1.5"
      >
        <NewTabMenuItem
          icon={MessagesSquare}
          label="New chat"
          shortcut={WORKSPACE_LEADER_SHORTCUTS.sessions.label}
          onSelect={() => open({ type: "session" })}
        />
        <NewTabMenuItem
          icon={Terminal}
          label="Terminal"
          onSelect={() => open({ type: "terminal" })}
        />
        <NewTabMenuItem
          icon={Globe}
          label="Browser"
          onSelect={() => open({ type: "browser" })}
        />
        <NewTabMenuItem
          icon={MonitorPlay}
          label="CDP Browser"
          onSelect={() => open({ type: "cdp-browser" })}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NewTabMenuItem({
  disabled,
  icon: Icon,
  label,
  onSelect,
  shortcut,
}: {
  disabled?: boolean;
  icon: typeof Plus;
  label: string;
  onSelect: () => void;
  shortcut?: string;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      className="gap-3 rounded-md px-3 py-2 text-[13px]"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="flex-1">{label}</span>
      {shortcut ? (
        <DropdownMenuShortcut className="ml-4 text-[12px]">
          {shortcut}
        </DropdownMenuShortcut>
      ) : null}
    </DropdownMenuItem>
  );
}

function useIsSessionTabRunning(tab: Tab): boolean {
  const tasks = useOptionalProjectTasks();
  if (tab.kind.type !== "session") return false;
  const taskId = tab.kind.taskId;
  if (!taskId || !tasks) return false;
  return Boolean(tasks.taskByKey.get(taskId)?.active_session_id);
}
