import { useLanguage } from "@/i18n";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { GitBranch as GitBranchIcon } from "lucide-react";
import { useRightDockStore } from "@/workspace-layout/state/right-dock-store";

type RunStatusPillProps = {
  /** Task identity, surfaced in the facts tooltip. */
  taskId?: string | null;
  /** The run's own branch; the primary label. */
  taskBranch?: string | null;
  /**
   * Branch this run was forked from and merges back into. Rendered after the
   * worktree branch as "worktree → target" so the destination is visible at a
   * glance instead of leaving it ambiguous where the work lands.
   */
  runTargetBranch?: string | null;
  /** Whether the run executes in an isolated worktree or the checkout itself. */
  useWorktree: boolean;

  /** Aggregate diff stats. Same source as the Git panel, so they always agree. */
  additions: number;
  deletions: number;
  /** Commits the target has that this branch does not. */
  commitsBehind: number;
};

const shortIdFromUuid = (id?: string | null, length = 8): string | null => {
  if (!id) return null;
  const compact = id.replace(/-/g, "");
  if (!compact) return null;
  return compact.slice(0, length).toLowerCase();
};

/**
 * Branch/diff status for the active run, and the entry point to the Git panel.
 *
 * Display and navigation only: the verbs that act on these changes (merge,
 * rebase, commit, push, pull) live in the Git panel next to the change list
 * they operate on, so this stays a single unambiguous click target rather than
 * a menu that duplicates them.
 */
export function RunStatusPill({
  taskId,
  taskBranch,
  runTargetBranch,
  useWorktree,
  additions,
  deletions,
  commitsBehind,
}: RunStatusPillProps) {
  const { t } = useLanguage();
  const setActivePanel = useRightDockStore((s) => s.setActivePanel);

  const shortId = shortIdFromUuid(taskId);
  const triggerLabel = taskBranch ?? shortId ?? t("runStatusNoBranch");
  // Only annotate the destination when the run heads somewhere other than its
  // own branch; a run without a branch yet has nothing to point at.
  const showTargetBranch = Boolean(
    taskBranch && runTargetBranch && runTargetBranch !== taskBranch,
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setActivePanel("source-control")}
            aria-label={t("runStatusOpenSourceControl")}
            className="inline-flex h-7 max-w-[300px] cursor-pointer items-center gap-1.5 rounded-sm border border-custom-border-200 px-2 text-[12px] text-custom-text-100 transition hover:bg-custom-background-80"
          >
            <GitBranchIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="flex min-w-0 flex-1 items-center gap-1">
              {/* The run's branch is the sole flexible part: it truncates to
                  fill whatever room is left so the target stays readable. */}
              <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
              {showTargetBranch && (
                <>
                  <span className="shrink-0 text-custom-text-300">→</span>
                  <span className="max-w-[160px] shrink-0 truncate text-custom-text-200">
                    {runTargetBranch}
                  </span>
                </>
              )}
            </span>
            {(additions > 0 || deletions > 0) && (
              <span className="shrink-0 font-mono text-[11px] tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-500">
                  +{additions.toLocaleString()}
                </span>{" "}
                <span className="text-red-500">
                  -{deletions.toLocaleString()}
                </span>
              </span>
            )}
            {commitsBehind > 0 && (
              <span className="shrink-0 rounded bg-custom-background-80 px-1.5 py-0.5 text-[10px] font-medium text-custom-text-300">
                ↓{commitsBehind}
              </span>
            )}
          </button>
        </TooltipTrigger>
        {/* Identity facts: low-frequency reference material, so it appears on
            demand rather than occupying the always-visible panel. */}
        <TooltipContent side="bottom" align="end" className="w-[220px] p-2.5">
          <div className="space-y-1 text-[11.5px]">
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-white/60">
                {t("runStatusExecution")}
              </span>
              <span>
                {useWorktree
                  ? t("runStatusWorktree")
                  : t("runStatusLocalCheckout")}
              </span>
            </div>
            {runTargetBranch && (
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-white/60">
                  {t("runStatusFrom")}
                </span>
                <span className="truncate">{runTargetBranch}</span>
              </div>
            )}
            {shortId && (
              <div className="flex gap-2">
                <span className="w-16 shrink-0 text-white/60">
                  {t("runStatusId")}
                </span>
                <span className="font-mono">{shortId}</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default RunStatusPill;
