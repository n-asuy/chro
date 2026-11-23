import { useLanguage } from "@/i18n";
import { useCloudAccessStore } from "@/lib/cloud-access-store";
import { localizeCloudMessage } from "@/lib/cloud-messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@chro/ui/popover";
import {
  Check,
  Cloud,
  Ellipsis,
  Folder,
  GitBranch as GitBranchIcon,
  GitFork,
  Laptop,
  Search,
} from "lucide-react";
import { type ReactNode, useState } from "react";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

export type BaseBranchOption = { name: string; is_current: boolean };

type DropdownAlign = "start" | "center" | "end";

// Same size and motion as the composer's "+" menu: the shared dropdown's own
// frame, padding and open/close animation, with its 13px rows and muted 16px
// icons. Only the width is set here.
const PICKER_CLASS = "w-64";
const ROW_CLASS = "gap-2.5 text-[13px]";
const ROW_ICON_CLASS = "h-4 w-4 shrink-0 text-muted-foreground";
const ROW_CHECK_CLASS = "ml-auto h-4 w-4 shrink-0";

function PickerContent({
  align = "start",
  placeholder,
  search,
  onSearchChange,
  children,
}: {
  align?: DropdownAlign;
  placeholder: string;
  search: string;
  onSearchChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuContent align={align} className={PICKER_CLASS}>
      <div className="mb-1 flex items-center gap-2.5 border-b border-border/40 px-2 py-1.5">
        <Search className={ROW_ICON_CLASS} />
        <input
          aria-label={placeholder}
          placeholder={placeholder}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
          }}
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="max-h-[320px] overflow-y-auto">{children}</div>
    </DropdownMenuContent>
  );
}

function PickerEmpty() {
  const { t } = useLanguage();
  return (
    <div className="px-2 py-3 text-center text-xs text-muted-foreground">
      {t("executionPickerEmpty")}
    </div>
  );
}

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
      <PickerContent
        align={align}
        placeholder={t("branchSelectorSearchPlaceholder")}
        search={baseBranchSearch}
        onSearchChange={onBaseBranchSearchChange}
      >
        {filteredBaseBranches.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {t("branchSelectorEmpty")}
          </div>
        ) : (
          filteredBaseBranches.map((branch) => (
            <DropdownMenuItem
              key={branch.name}
              onClick={() => onBaseBranchSelect(branch.name)}
              className={ROW_CLASS}
            >
              <GitBranchIcon className={ROW_ICON_CLASS} />
              <span className="min-w-0 flex-1 truncate">
                {branch.name}

                {branch.is_current && (
                  <span className="ml-2 text-muted-foreground">
                    {t("branchSelectorCurrent")}
                  </span>
                )}
              </span>
              {baseBranch === branch.name && (
                <Check className={ROW_CHECK_CLASS} />
              )}
            </DropdownMenuItem>
          ))
        )}
      </PickerContent>
    </DropdownMenu>
  );
}

// Borderless chip matching the composer tray: a leading icon and a label that sit
// directly on the tray surface (no pill outline, no chevron).
const CHIP_CLASS =
  "inline-flex h-8 min-w-0 max-w-[240px] items-center gap-2 rounded-full px-3 text-[13px] text-foreground transition-colors hover:bg-foreground/5 data-[state=open]:bg-foreground/5 disabled:pointer-events-none disabled:opacity-40";
const CHIP_ICON_CLASS = "h-4 w-4 shrink-0";

/**
 * Execution controls for a not-yet-started session, rendered as one row of
 * chips on the tray above the composer: execution location (behind the cloud
 * flag), the "From" base branch, and the worktree/current-checkout mode. Once a session starts these live in the
 * header environment popover instead.
 *
 * The caller styles the surrounding tray via {@link className}.
 */
export function NewSessionExecutionControls({
  className,
  cloudEnabled = false,
  executionLocation = "computer",
  onExecutionLocationChange,
  onCloudSignInPendingChange,
  useWorktree,
  onUseWorktreeChange,
  baseBranch,
  baseBranchSearch,
  onBaseBranchSearchChange,
  filteredBaseBranches,
  onBaseBranchSelect,
}: {
  className?: string;
  cloudEnabled?: boolean;
  executionLocation?: "computer" | "cloud";
  onExecutionLocationChange?: (location: "computer" | "cloud") => void;
  onCloudSignInPendingChange?: (pending: boolean) => void;
  useWorktree: boolean;
  onUseWorktreeChange: (next: boolean) => void;
  baseBranch: string | null;
  baseBranchSearch: string;
  onBaseBranchSearchChange: (value: string) => void;
  filteredBaseBranches: BaseBranchOption[];
  onBaseBranchSelect: (name: string) => void;
}) {
  const { t } = useLanguage();
  const checkoutLabel = useWorktree
    ? t("environmentWorktreeLabel")
    : t("environmentLocalLabel");
  const [environmentSearch, setEnvironmentSearch] = useState("");
  const [locationSearch, setLocationSearch] = useState("");
  const matches = (search: string, label: string) =>
    label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectCloud = async () => {
    setError(null);
    setSigningIn(true);
    onCloudSignInPendingChange?.(true);
    try {
      await useCloudAccessStore.getState().refresh();
      if (!useCloudAccessStore.getState().signedIn) {
        throw new Error("Sign in to Cloud first");
      }
      onExecutionLocationChange?.("cloud");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSigningIn(false);
      onCloudSignInPendingChange?.(false);
    }
  };
  const locationLabel =
    executionLocation === "cloud"
      ? t("cloudLocationCloud")
      : t("cloudLocationComputer");

  const modeControls = (
    <>
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
            <GitBranchIcon className={CHIP_ICON_CLASS} />
            <span className="min-w-0 truncate">{baseBranch ?? "main"}</span>
          </button>
        }
      />
      <DropdownMenu onOpenChange={() => setEnvironmentSearch("")}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={CHIP_CLASS}
            aria-label={checkoutLabel}
          >
            {useWorktree ? (
              <GitFork className={CHIP_ICON_CLASS} />
            ) : (
              <Folder className={CHIP_ICON_CLASS} />
            )}
            <span className="min-w-0 truncate">{checkoutLabel}</span>
          </button>
        </DropdownMenuTrigger>
        <PickerContent
          placeholder={t("executionEnvironmentSearch")}
          search={environmentSearch}
          onSearchChange={setEnvironmentSearch}
        >
          {[true, false]
            .filter((worktree) =>
              matches(
                environmentSearch,
                worktree
                  ? t("environmentWorktreeLabel")
                  : t("environmentLocalLabel"),
              ),
            )
            .map((worktree) => (
              <DropdownMenuItem
                key={String(worktree)}
                role="menuitemradio"
                aria-checked={useWorktree === worktree}
                onSelect={() => onUseWorktreeChange(worktree)}
                className={ROW_CLASS}
              >
                {worktree ? (
                  <GitFork className={ROW_ICON_CLASS} />
                ) : (
                  <Folder className={ROW_ICON_CLASS} />
                )}
                <span className="flex-1">
                  {worktree
                    ? t("environmentWorktreeLabel")
                    : t("environmentLocalLabel")}
                </span>
                {useWorktree === worktree && (
                  <Check className={ROW_CHECK_CLASS} />
                )}
              </DropdownMenuItem>
            ))}
          {![t("environmentWorktreeLabel"), t("environmentLocalLabel")].some(
            (label) => matches(environmentSearch, label),
          ) && <PickerEmpty />}
        </PickerContent>
      </DropdownMenu>
    </>
  );

  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      {cloudEnabled && (
        <DropdownMenu onOpenChange={() => setLocationSearch("")}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={CHIP_CLASS}
              disabled={signingIn}
              aria-label={locationLabel}
            >
              {executionLocation === "cloud" ? (
                <Cloud className={CHIP_ICON_CLASS} />
              ) : (
                <Laptop className={CHIP_ICON_CLASS} />
              )}
              <span className="min-w-0 truncate">
                {signingIn ? t("cloudSigningIn") : locationLabel}
              </span>
            </button>
          </DropdownMenuTrigger>
          <PickerContent
            placeholder={t("cloudWorkIn")}
            search={locationSearch}
            onSearchChange={setLocationSearch}
          >
            {matches(locationSearch, t("cloudLocationComputer")) && (
              <DropdownMenuItem
                role="menuitemradio"
                aria-checked={executionLocation === "computer"}
                onSelect={() => onExecutionLocationChange?.("computer")}
                className={ROW_CLASS}
              >
                <Laptop className={ROW_ICON_CLASS} />
                <span className="flex-1">{t("cloudLocationComputer")}</span>
                {executionLocation === "computer" && (
                  <Check className={ROW_CHECK_CLASS} />
                )}
              </DropdownMenuItem>
            )}
            {matches(
              locationSearch,
              `${t("cloudLocationCloud")} ${t("cloudDefaultEnvironment")}`,
            ) && (
              <DropdownMenuItem
                role="menuitemradio"
                aria-checked={executionLocation === "cloud"}
                onSelect={() => void selectCloud()}
                className={ROW_CLASS}
              >
                <Cloud className={ROW_ICON_CLASS} />
                <span>{t("cloudLocationCloud")}</span>
                <span className="text-muted-foreground">
                  {t("cloudDefaultEnvironment")}
                </span>
                {executionLocation === "cloud" && (
                  <Check className={ROW_CHECK_CLASS} />
                )}
              </DropdownMenuItem>
            )}
            {!matches(locationSearch, t("cloudLocationComputer")) &&
              !matches(
                locationSearch,
                `${t("cloudLocationCloud")} ${t("cloudDefaultEnvironment")}`,
              ) && <PickerEmpty />}
          </PickerContent>
        </DropdownMenu>
      )}
      {cloudEnabled ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={CHIP_CLASS}
              aria-label={t("executionMoreOptions")}
            >
              <Ellipsis className={CHIP_ICON_CLASS} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className={cn(
              PICKER_CLASS,
              "flex flex-col items-start gap-1 rounded-xl p-1",
            )}
          >
            {modeControls}
          </PopoverContent>
        </Popover>
      ) : (
        modeControls
      )}
      {error && (
        <span
          role="alert"
          className="min-w-0 truncate text-xs text-destructive"
        >
          {localizeCloudMessage(error, t, "cloudSignInFailed")}
        </span>
      )}
    </div>
  );
}
