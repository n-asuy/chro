import type { TranslationFunction } from "@/i18n";
import type { TaskStatusDotKind } from "@/session/domain/task-read-state";
import { Circle, CircleSlash, TriangleAlert } from "lucide-react";

/**
 * Leading status marker rendered before every session title so the list keeps
 * a consistent left rail: a quiet hollow bullet by default, a solid blue
 * bullet for an unread completed run, an amber warning glyph for an unread
 * failure, and a struck-through bullet for a session whose worktree has been
 * reclaimed. Shared by the sidebar and the quick-switcher palette so session
 * rows read the same everywhere.
 *
 * The circle markers all share one size so the rail reads as a single column.
 * The struck-through circle borrows the universal "unavailable" slash rather
 * than a subtler outline treatment, because the row it marks is one the user
 * can no longer act on; a tooltip spells that out on hover.
 */
export function SessionLeadingMarker({
  kind,
  t,
}: {
  kind: TaskStatusDotKind;
  t: TranslationFunction;
}) {
  if (kind === "failed") {
    return (
      <TriangleAlert
        role="status"
        aria-label={t("sessionFailedUnread")}
        className="size-3 text-amber-500"
      />
    );
  }
  if (kind === "completed") {
    return (
      <Circle
        role="status"
        aria-label={t("sessionCompletedUnread")}
        className="size-2.5 fill-[#307BD0] text-[#307BD0]"
      />
    );
  }
  if (kind === "cleaned") {
    // The slash alone can't say why the row is dead, so the wrapper carries a
    // native tooltip (lucide icons don't take a `title` prop).
    return (
      <span
        title={t("sessionWorktreeCleaned")}
        className="flex items-center justify-center"
      >
        <CircleSlash
          role="status"
          aria-label={t("sessionWorktreeCleaned")}
          className="size-2.5 text-custom-sidebar-text-400"
        />
      </span>
    );
  }
  // Idle, running, or already-viewed: a decorative hollow bullet.
  return (
    <Circle
      aria-hidden="true"
      className="size-2.5 text-custom-sidebar-text-400"
    />
  );
}
