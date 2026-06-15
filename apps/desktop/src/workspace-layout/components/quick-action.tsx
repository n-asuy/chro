import { cn } from "@/lib/cn";
import type { ComponentType, ReactNode } from "react";

/**
 * A single row in the minimal "Open"/"Recent" launcher columns shared by the
 * empty-pane state and the project overview. Icon on the left, label filling
 * the row, and an optional trailing slot (a keyboard hint or a timestamp).
 */
export function QuickAction({
  icon: Icon,
  label,
  shortcut,
  trailing,
  onClick,
}: {
  /**
   * Leading glyph. Any component accepting `className` works: lucide icons for
   * actions, or an agent logo bound to a session (see {@link AgentLogo}). A
   * component that renders `null` (e.g. an unknown agent) simply shows no glyph.
   */
  icon: ComponentType<{ className?: string }>;
  label: ReactNode;
  /** Keyboard hint rendered as a `<kbd>`. Ignored when `trailing` is set. */
  shortcut?: string;
  /** Free-form trailing content (e.g. a relative timestamp). */
  trailing?: ReactNode;
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
      <Icon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ??
        (shortcut ? (
          <kbd className="rounded bg-muted px-1.5 py-0.5 text-[10px] opacity-60">
            {shortcut}
          </kbd>
        ) : null)}
    </button>
  );
}
