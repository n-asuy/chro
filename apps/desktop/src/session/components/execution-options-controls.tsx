import { useLanguage } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import {
  Check,
  GitBranch as GitBranchIcon,
  Laptop,
  Search,
} from "lucide-react";
import type { ReactNode } from "react";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

export type BaseBranchOption = { name: string; is_current: boolean };

type DropdownAlign = "start" | "center" | "end";

/**
 * Searchable "From" base-branch picker. The caller supplies the trigger so the
 * same picker can render as a vertical popover row or a compact inline pill
 * without duplicating the search/list markup.
 */
export function BaseBranchDropdown({
  trigger,
  baseBranch,
  baseBranchSearch,
  onBaseBranchSearchChange,
  filteredBaseBranches,
  onBaseBranchSelect,
  align = "end",
}: {
  trigger: ReactNode;
  baseBranch: string | null;
  baseBranchSearch: string;
  onBaseBranchSearchChange: (value: string) => void;
  filteredBaseBranches: BaseBranchOption[];
  onBaseBranchSelect: (name: string) => void;
  align?: DropdownAlign;
}) {
  const { t } = useLanguage();
  return (
    <DropdownMenu
      onOpenChange={(next) => {
        if (!next) onBaseBranchSearchChange("");
      }}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <div className="p-2">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder={t("branchSelectorSearchPlaceholder")}
              value={baseBranchSearch}
              onChange={(e) => onBaseBranchSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                e.stopPropagation();
              }}
              className="w-full rounded-sm border border-border bg-background py-1.5 pl-7 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-48 overflow-y-auto">
          {filteredBaseBranches.length === 0 ? (
            <div className="p-2 text-center text-[11px] text-muted-foreground">
              {t("branchSelectorEmpty")}
            </div>
          ) : (
            filteredBaseBranches.map((branch) => (
              <DropdownMenuItem
                key={branch.name}
                onClick={() => onBaseBranchSelect(branch.name)}
                className="flex items-center justify-between gap-3 text-[11px]"
              >
                <span className="min-w-0 truncate">{branch.name}</span>
                <div className="flex flex-shrink-0 items-center gap-1">
                  {branch.is_current && (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      {t("branchSelectorCurrent")}
                    </span>
                  )}
                  {baseBranch === branch.name && (
                    <Check className="h-3.5 w-3.5" />
                  )}
                </div>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Worktree vs Local execution toggle. The caller supplies the trigger for the
 * same reason as {@link BaseBranchDropdown}.
 */
export function WorktreeModeDropdown({
  trigger,
  useWorktree,
  onUseWorktreeChange,
  align = "end",
}: {
  trigger: ReactNode;
  useWorktree: boolean;
  onUseWorktreeChange: (next: boolean) => void;
  align?: DropdownAlign;
}) {
  const { t } = useLanguage();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        <DropdownMenuItem
          onClick={() => onUseWorktreeChange(true)}
          className="flex items-center justify-between gap-3 text-[12px]"
        >
          <span>{t("environmentWorktreeLabel")}</span>
          {useWorktree ? <Check className="h-3.5 w-3.5" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onUseWorktreeChange(false)}
          className="flex items-center justify-between gap-3 text-[12px]"
        >
          <span>{t("environmentLocalLabel")}</span>
          {!useWorktree ? <Check className="h-3.5 w-3.5" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Borderless chip styled after the reference design: a muted leading icon and a
// dark label that sit directly on the tray surface (no pill outline, no chevron).
// text-[13px] matches the environment popover rows that host these same
// From/Worktree controls, keeping the type scale consistent across surfaces.
const CHIP_CLASS =
  "inline-flex min-w-0 max-w-[240px] items-center gap-2 rounded-md px-2 py-1 text-[13px] text-foreground transition hover:bg-foreground/5 disabled:pointer-events-none disabled:opacity-40";

/**
 * Inline execution controls shown beneath the prompt for a not-yet-started
 * session: a "From" base-branch picker and the Worktree/Local toggle. Once a
 * session starts these live in the header environment popover instead.
 *
 * The caller styles the surrounding tray via {@link className}; this renders the
 * single centered row of chips.
 */
export function NewSessionExecutionControls({
  className,
  useWorktree,
  onUseWorktreeChange,
  baseBranch,
  baseBranchSearch,
  onBaseBranchSearchChange,
  filteredBaseBranches,
  onBaseBranchSelect,
}: {
  className?: string;
  useWorktree: boolean;
  onUseWorktreeChange: (next: boolean) => void;
  baseBranch: string | null;
  baseBranchSearch: string;
  onBaseBranchSearchChange: (value: string) => void;
  filteredBaseBranches: BaseBranchOption[];
  onBaseBranchSelect: (name: string) => void;
}) {
  const { t } = useLanguage();

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <BaseBranchDropdown
        align="start"
        baseBranch={baseBranch}
        baseBranchSearch={baseBranchSearch}
        onBaseBranchSearchChange={onBaseBranchSearchChange}
        filteredBaseBranches={filteredBaseBranches}
        onBaseBranchSelect={onBaseBranchSelect}
        trigger={
          <button
            type="button"
            className={CHIP_CLASS}
            aria-label={t("environmentFromLabel")}
          >
            <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{baseBranch ?? "main"}</span>
          </button>
        }
      />
      <WorktreeModeDropdown
        align="start"
        useWorktree={useWorktree}
        onUseWorktreeChange={onUseWorktreeChange}
        trigger={
          <button type="button" className={CHIP_CLASS}>
            <Laptop className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">
              {useWorktree
                ? t("environmentWorktreeLabel")
                : t("environmentLocalLabel")}
            </span>
          </button>
        }
      />
    </div>
  );
}
