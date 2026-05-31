import { cn } from "@/lib/cn";
import { MessagesSquare, Search } from "lucide-react";
import { WORKSPACE_LEADER_SHORTCUTS } from "../lib/keyboard-shortcuts";
import { useLayoutStore } from "../state/layout-store";
import { useRightDockStore } from "../state/right-dock-store";
import type { TabKind } from "../types";

interface EmptyPaneStateProps {
  leafId: string;
}

export function EmptyPaneState({ leafId }: EmptyPaneStateProps) {
  const openTab = useLayoutStore((s) => s.openTab);
  const focusSearchPanel = useRightDockStore((s) => s.focusSearchPanel);

  const open = (kind: TabKind) => openTab(kind, { targetLeafId: leafId });

  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/10 text-muted-foreground">
      <div className="flex w-72 flex-col gap-3 text-sm">
        <div className="text-xs uppercase tracking-wider opacity-60">Open</div>
        <QuickAction
          icon={MessagesSquare}
          label="Sessions"
          shortcut={WORKSPACE_LEADER_SHORTCUTS.sessions.label}
          onClick={() => open({ type: "session" })}
        />
        <QuickAction
          icon={Search}
          label="Search files…"
          shortcut="⌘K"
          onClick={focusSearchPanel}
        />
      </div>
    </div>
  );
}

function QuickAction({
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  icon: typeof MessagesSquare;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded border border-transparent px-2 py-1.5 text-left",
        "hover:border-border hover:bg-background",
      )}
    >
      <Icon className="h-4 w-4 opacity-70" />
      <span className="flex-1">{label}</span>
      {shortcut ? (
        <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px] opacity-60">
          {shortcut}
        </kbd>
      ) : null}
    </button>
  );
}
