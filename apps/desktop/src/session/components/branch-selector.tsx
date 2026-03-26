
import { useState, useMemo, useRef, useCallback, memo } from "react";
import { Button } from "@chro/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { ChevronDown, GitBranch as GitBranchIcon, Search } from "lucide-react";
import { useLanguage } from "@/i18n";

export type GitBranch = {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  last_commit_timestamp: number | null;
};

type BranchSelectorProps = {
  branches: GitBranch[];
  selectedBranch: string | null;
  onBranchSelect: (branch: string) => void;
  placeholder?: string;
  className?: string;
  excludeCurrentBranch?: boolean;
  disabled?: boolean;
};

type BranchRowProps = {
  branch: GitBranch;
  isSelected: boolean;
  isDisabled: boolean;
  onSelect: () => void;
};

const BranchRow = memo(function BranchRow({
  branch,
  isSelected,
  isDisabled,
  onSelect,
}: BranchRowProps) {
  const { t } = useLanguage();
  const classes =
    (isSelected ? "bg-accent text-accent-foreground " : "") +
    (isDisabled ? "opacity-50 cursor-not-allowed " : "");

  const nameClass = branch.is_current ? "font-medium" : "";

  return (
    <DropdownMenuItem
      onSelect={onSelect}
      disabled={isDisabled}
      className={classes.trim()}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className={`${nameClass} min-w-0 flex-1 truncate`}>
          {branch.name}
        </span>
        <div className="flex flex-shrink-0 gap-1">
          {branch.is_current && (
            <span className="rounded bg-background px-1 text-xs">
              {t("branchSelectorCurrent")}
            </span>
          )}
          {branch.is_remote && (
            <span className="rounded bg-background px-1 text-xs">
              {t("branchSelectorRemote")}
            </span>
          )}
        </div>
      </div>
    </DropdownMenuItem>
  );
});

export function BranchSelector({
  branches,
  selectedBranch,
  onBranchSelect,
  placeholder,
  className = "",
  excludeCurrentBranch = false,
  disabled = false,
}: BranchSelectorProps) {
  const { t } = useLanguage();
  const [branchSearchTerm, setBranchSearchTerm] = useState("");
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const effectivePlaceholder = placeholder ?? t("branchSelectorPlaceholder");

  const filteredBranches = useMemo(() => {
    let filtered = branches;

    if (branchSearchTerm.trim()) {
      const q = branchSearchTerm.toLowerCase();
      filtered = filtered.filter((b) => b.name.toLowerCase().includes(q));
    }
    return filtered;
  }, [branches, branchSearchTerm]);

  const handleBranchSelect = useCallback(
    (branchName: string) => {
      onBranchSelect(branchName);
      setBranchSearchTerm("");
      setOpen(false);
    },
    [onBranchSelect],
  );

  const isBranchDisabled = useCallback(
    (branch: GitBranch) => excludeCurrentBranch && branch.is_current,
    [excludeCurrentBranch],
  );

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setBranchSearchTerm("");
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={`w-full justify-between text-xs ${className}`}
        >
          <div className="flex w-full min-w-0 items-center gap-1.5">
            <GitBranchIcon className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">
              {selectedBranch || effectivePlaceholder}
            </span>
          </div>
          <ChevronDown className="h-3 w-3 flex-shrink-0" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-80">
        <div className="p-2">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t("branchSelectorSearchPlaceholder")}
              value={branchSearchTerm}
              onChange={(e) => setBranchSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  return;
                }
                e.stopPropagation();
              }}
              className="w-full rounded-sm border border-border bg-background py-2 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-64 overflow-y-auto">
          {filteredBranches.length === 0 ? (
            <div className="p-2 text-center text-sm text-muted-foreground">
              {t("branchSelectorEmpty")}
            </div>
          ) : (
            filteredBranches.map((branch) => {
              const isDisabled = isBranchDisabled(branch);
              const isSelected = selectedBranch === branch.name;

              return (
                <BranchRow
                  key={branch.name}
                  branch={branch}
                  isSelected={isSelected}
                  isDisabled={isDisabled}
                  onSelect={() => handleBranchSelect(branch.name)}
                />
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default BranchSelector;
