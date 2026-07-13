import { useLanguage } from "@/i18n";
import { Button } from "@chro/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@chro/ui/popover";
import {
  ChevronDown,
  ChevronRight,
  GitBranch as GitBranchIcon,
  GitMerge,
  GitPullRequestArrow,
  Laptop,
  Loader2,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BranchSelector, type GitBranch } from "./branch-selector";
import {
  BaseBranchDropdown,
  WorktreeModeDropdown,
} from "./execution-options-controls";

export type RebaseConfirmResult = {
  targetBranch: string;
  upstreamBranch: string;
};

type EnvironmentPopoverProps = {
  /** Task identity surfaced in the trigger and the metadata footer. */
  taskId?: string | null;
  taskBranch?: string | null;
  /**
   * Branch this run was forked from and merges back into. Rendered after the
   * worktree branch in the trigger as "worktree → target" so the destination is
   * visible at a glance instead of leaving it ambiguous where the work lands.
   */
  runTargetBranch?: string | null;

  /** Whether the active project is a Git repository. */
  isGitRepository: boolean;
  /** Locks execution-config rows (worktree, base branch) while a run is active. */
  isExecutorLocked: boolean;

  /** Aggregate diff stats surfaced in the trigger pill. */
  additions: number;
  deletions: number;
  hasDiffs: boolean;

  /** Worktree vs Local execution toggle. */
  useWorktree: boolean;
  onUseWorktreeChange: (next: boolean) => void;

  /** Base branch ("From") picker. */
  baseBranch: string | null;
  baseBranchSearch: string;
  onBaseBranchSearchChange: (value: string) => void;
  filteredBaseBranches: Array<{ name: string; is_current: boolean }>;
  onBaseBranchSelect: (name: string) => void;

  /** Rebase control. */
  canRebase: boolean;
  isRebasing: boolean;
  commitsBehind: number;
  branches: GitBranch[];
  isLoadingBranches: boolean;
  initialTargetBranch?: string;
  initialUpstreamBranch?: string;
  onRebaseConfirm: (result: RebaseConfirmResult) => void;

  /** Merge control. */
  canMergeDiffs: boolean;
  isMergingDiffs: boolean;
  onMergeDiffs: () => void;

  /** Git repository initialization (non-Git projects). */
  isInitializingGit: boolean;
  canInitGit: boolean;
  onInitGitRepo: () => void;

  /** Notifies the parent so it can lazily load rebase branches on open. */
  onOpenChange?: (open: boolean) => void;
};

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

const shortIdFromUuid = (id?: string | null, length = 8): string | null => {
  if (!id) return null;
  const compact = id.replace(/-/g, "");
  if (!compact) return null;
  return compact.slice(0, length).toLowerCase();
};

const ROW_CLASS =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-40";

export function EnvironmentPopover({
  taskId,
  taskBranch,
  runTargetBranch,
  isGitRepository,
  isExecutorLocked,
  additions,
  deletions,
  hasDiffs,
  useWorktree,
  onUseWorktreeChange,
  baseBranch,
  baseBranchSearch,
  onBaseBranchSearchChange,
  filteredBaseBranches,
  onBaseBranchSelect,
  canRebase,
  isRebasing,
  commitsBehind,
  branches,
  isLoadingBranches,
  initialTargetBranch,
  initialUpstreamBranch,
  onRebaseConfirm,
  canMergeDiffs,
  isMergingDiffs,
  onMergeDiffs,
  isInitializingGit,
  canInitGit,
  onInitGitRepo,
  onOpenChange,
}: EnvironmentPopoverProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [rebaseExpanded, setRebaseExpanded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [targetBranch, setTargetBranch] = useState(initialTargetBranch ?? "");
  const [upstreamBranch, setUpstreamBranch] = useState(
    initialUpstreamBranch ?? "",
  );

  useEffect(() => {
    if (initialTargetBranch) setTargetBranch(initialTargetBranch);
  }, [initialTargetBranch]);

  useEffect(() => {
    if (initialUpstreamBranch) setUpstreamBranch(initialUpstreamBranch);
  }, [initialUpstreamBranch]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
      if (!next) {
        setRebaseExpanded(false);
        setShowAdvanced(false);
        setTargetBranch(initialTargetBranch ?? "");
        setUpstreamBranch(initialUpstreamBranch ?? "");
      }
    },
    [onOpenChange, initialTargetBranch, initialUpstreamBranch],
  );

  const handleRebaseConfirm = useCallback(() => {
    const trimmedTarget = targetBranch.trim();
    if (!trimmedTarget) return;
    onRebaseConfirm({
      targetBranch: trimmedTarget,
      upstreamBranch: upstreamBranch.trim() || trimmedTarget,
    });
    handleOpenChange(false);
  }, [targetBranch, upstreamBranch, onRebaseConfirm, handleOpenChange]);

  const handleMerge = useCallback(() => {
    onMergeDiffs();
  }, [onMergeDiffs]);

  const shortId = shortIdFromUuid(taskId);
  const triggerLabel =
    taskBranch ?? baseBranch ?? shortId ?? t("environmentLabel");
  // Only annotate the destination when we have a real worktree branch heading
  // somewhere else; a new session (no task branch yet) already shows its base.
  const showTargetBranch = Boolean(
    taskBranch && runTargetBranch && runTargetBranch !== taskBranch,
  );
  const canConfirmRebase = targetBranch.trim().length > 0 && !isRebasing;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="inline-flex h-7 max-w-[300px] items-center gap-1.5 rounded-sm text-[12px]"
        >
          <GitBranchIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {/* Worktree branch is the sole flexible part: it truncates to fill
                whatever room is left so the target branch stays readable. */}
            <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
            {showTargetBranch && (
              <>
                <span className="shrink-0 text-muted-foreground/50">→</span>
                {/* Target (e.g. main/develop) keeps its natural width and never
                    truncates first; capped so a long branch can't blow out. */}
                <span className="max-w-[160px] shrink-0 truncate text-muted-foreground">
                  {runTargetBranch}
                </span>
              </>
            )}
          </span>
          {hasDiffs && (
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
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
              ↓{commitsBehind}
            </span>
          )}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[320px] p-0">
        <div className="px-3 pb-1.5 pt-3">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {t("environmentLabel")}
          </span>
        </div>

        {isGitRepository ? (
          <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
            {/* Worktree / Local */}
            <WorktreeModeDropdown
              useWorktree={useWorktree}
              onUseWorktreeChange={onUseWorktreeChange}
              trigger={
                <button
                  type="button"
                  disabled={isExecutorLocked}
                  className={ROW_CLASS}
                >
                  <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 text-left">
                    {useWorktree
                      ? t("environmentWorktreeLabel")
                      : t("environmentLocalLabel")}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              }
            />

            {/* From (base branch) */}
            <BaseBranchDropdown
              baseBranch={baseBranch}
              baseBranchSearch={baseBranchSearch}
              onBaseBranchSearchChange={onBaseBranchSearchChange}
              filteredBaseBranches={filteredBaseBranches}
              onBaseBranchSelect={onBaseBranchSelect}
              trigger={
                <button
                  type="button"
                  disabled={isExecutorLocked}
                  className={ROW_CLASS}
                >
                  <GitBranchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-muted-foreground">
                    {t("environmentFromLabel")}
                  </span>
                  <span className="flex-1 truncate text-left font-medium">
                    {baseBranch ?? "main"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              }
            />

            {/* Rebase (expandable) */}
            <div>
              <button
                type="button"
                className={ROW_CLASS}
                onClick={() => setRebaseExpanded((prev) => !prev)}
                disabled={!canRebase}
              >
                {isRebasing ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <GitPullRequestArrow className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="flex-1 text-left">
                  {isRebasing
                    ? t("rebaseInProgressLabel")
                    : t("rebaseButtonLabel")}
                </span>
                {commitsBehind > 0 && !isRebasing && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                    ↓{commitsBehind}
                  </span>
                )}
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                    rebaseExpanded && "rotate-90",
                  )}
                />
              </button>

              {rebaseExpanded && (
                <div className="space-y-3 px-2 pb-2 pt-1">
                  <div className="space-y-1.5">
                    <span className="text-[12px] font-medium text-foreground">
                      {t("rebaseTargetLabel")}
                    </span>
                    {isLoadingBranches ? (
                      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>{t("branchSelectorLoading")}</span>
                      </div>
                    ) : (
                      <BranchSelector
                        branches={branches}
                        selectedBranch={targetBranch || null}
                        onBranchSelect={setTargetBranch}
                        disabled={isRebasing}
                      />
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced((prev) => !prev)}
                      className="flex w-full items-center gap-1.5 text-left text-[12px] text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight
                        className={cn(
                          "h-3 w-3 transition-transform",
                          showAdvanced && "rotate-90",
                        )}
                      />
                      <span>{t("rebaseAdvancedLabel")}</span>
                    </button>

                    {showAdvanced && (
                      <div className="space-y-1.5 pl-4">
                        <span className="text-[12px] font-medium text-foreground">
                          {t("rebaseUpstreamLabel")}
                        </span>
                        {isLoadingBranches ? (
                          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>{t("branchSelectorLoading")}</span>
                          </div>
                        ) : (
                          <BranchSelector
                            branches={branches}
                            selectedBranch={upstreamBranch || null}
                            onBranchSelect={setUpstreamBranch}
                            disabled={isRebasing}
                          />
                        )}
                        <p className="text-[11px] text-muted-foreground">
                          {t("rebaseUpstreamHint")}
                        </p>
                      </div>
                    )}
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    className="w-full"
                    onClick={handleRebaseConfirm}
                    disabled={!canConfirmRebase}
                  >
                    {isRebasing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t("rebaseInProgressLabel")}
                      </>
                    ) : (
                      t("rebaseConfirmLabel")
                    )}
                  </Button>
                </div>
              )}
            </div>

            {/* Merge (primary action) */}
            <div className="mt-1.5 px-0.5 pt-1.5">
              <Button
                type="button"
                size="sm"
                onClick={handleMerge}
                disabled={!canMergeDiffs}
                className="w-full justify-center gap-1.5 text-[12px]"
              >
                {isMergingDiffs ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitMerge className="h-3.5 w-3.5" />
                )}
                <span>
                  {isMergingDiffs
                    ? t("diffMergingLabel")
                    : t("diffMergeButtonLabel")}
                </span>
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
            <div className={cn(ROW_CLASS, "pointer-events-none")}>
              <Laptop className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-left">
                {t("environmentLocalLabel")}
              </span>
            </div>
            <button
              type="button"
              className={ROW_CLASS}
              onClick={onInitGitRepo}
              disabled={isInitializingGit || !canInitGit}
            >
              {isInitializingGit ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex-1 text-left">
                {isInitializingGit
                  ? t("environmentInitializingGit")
                  : t("environmentCreateGitRepo")}
              </span>
            </button>
          </div>
        )}

        {(shortId || taskBranch) && (
          <div className="space-y-1 border-t border-border px-3 py-2.5">
            {shortId && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-12 shrink-0 text-muted-foreground">
                  {t("environmentIdLabel")}
                </span>
                <span className="truncate font-mono text-foreground">
                  {shortId}
                </span>
              </div>
            )}
            {taskBranch && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-12 shrink-0 text-muted-foreground">
                  {t("environmentBranchLabel")}
                </span>
                <span className="truncate font-mono text-foreground">
                  {taskBranch}
                </span>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default EnvironmentPopover;
