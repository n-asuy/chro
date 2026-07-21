import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { selectFlag, useFeatureFlagStore } from "@/lib/feature-flags-store";
import type { FlagStatus, FlagView } from "@/lib/flags-client";
import { Badge } from "@chro/ui/badge";
import { Button } from "@chro/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Check, ChevronDown, Loader2, RefreshCcw } from "lucide-react";
import { SettingsSection } from "./settings-section";

const STATUS_VARIANT: Record<
  FlagStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  experimental: "secondary",
  rolling_out: "default",
  graduated: "outline",
  killed: "destructive",
};

/** `null` follows the resolved value; a boolean forces the flag locally. */
type OverrideChoice = boolean | null;

/**
 * Developer panel for the feature-flag registry. The registry itself is owned
 * by the backend; this only layers a local override so both sides of a flag can
 * be exercised without a PostHog rollout.
 */
export function FeatureFlagsSection() {
  const { t } = useLanguage();
  const registry = useFeatureFlagStore((state) => state.registry);
  const overrides = useFeatureFlagStore((state) => state.overrides);
  const loading = useFeatureFlagStore((state) => state.loading);
  const load = useFeatureFlagStore((state) => state.load);
  const setOverride = useFeatureFlagStore((state) => state.setOverride);
  const clearOverrides = useFeatureFlagStore((state) => state.clearOverrides);

  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <SettingsSection
      heading={t("developerFlagsTitle")}
      action={
        <div className="flex items-center gap-1">
          {hasOverrides ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearOverrides}
              className="font-workspace text-[13px] text-muted-foreground hover:text-foreground"
            >
              {t("developerFlagsResetOverrides")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="font-workspace gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            {t("reloadButton")}
          </Button>
        </div>
      }
    >
      {loading && registry.length === 0 ? (
        <div className="px-5 py-4">
          <div className="font-workspace flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("loadingMessage")}
          </div>
        </div>
      ) : registry.length === 0 ? (
        <div className="px-5 py-4">
          <p className="font-workspace text-[12px] text-muted-foreground">
            {t("developerFlagsEmpty")}
          </p>
        </div>
      ) : (
        registry.map((flag) => (
          <FlagRow
            key={flag.key}
            flag={flag}
            override={overrides[flag.key] ?? null}
            onOverrideChange={(value) => setOverride(flag.key, value)}
          />
        ))
      )}
    </SettingsSection>
  );
}

interface FlagRowProps {
  flag: FlagView;
  override: OverrideChoice;
  onOverrideChange: (value: OverrideChoice) => void;
}

function FlagRow({ flag, override, onOverrideChange }: FlagRowProps) {
  const { t } = useLanguage();
  const effective = useFeatureFlagStore((state) => selectFlag(state, flag.key));

  const onLabel = t("developerFlagsOn");
  const offLabel = t("developerFlagsOff");

  const options: { value: OverrideChoice; label: string }[] = [
    {
      value: null,
      label: t("developerFlagsFollowResolved", {
        value: flag.resolved_value ? onLabel : offLabel,
      }),
    },
    { value: true, label: t("developerFlagsForceOn") },
    { value: false, label: t("developerFlagsForceOff") },
  ];
  const selected = options.find((option) => option.value === override);

  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-workspace text-[13px] font-semibold text-foreground">
            {flag.key}
          </code>
          <Badge
            variant={STATUS_VARIANT[flag.status]}
            className="font-workspace text-[10px]"
          >
            {flag.status}
          </Badge>
          <span
            className={cn(
              "font-workspace text-[11px] font-semibold uppercase tracking-wide",
              effective ? "text-emerald-500" : "text-muted-foreground",
            )}
          >
            {effective ? onLabel : offLabel}
          </span>
        </div>
        <p className="font-workspace text-[12px] text-muted-foreground">
          {flag.description}
        </p>
        <p className="font-workspace text-[11px] text-muted-foreground/70">
          {t("developerFlagsMeta", {
            owner: flag.owner,
            date: flag.retire_by,
            rollout: t(
              flag.rollout === "remote"
                ? "developerFlagsRolloutRemote"
                : "developerFlagsRolloutLocal",
            ),
          })}
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("developerFlagsOverrideLabel", { key: flag.key })}
            className="font-workspace text-[13px] flex h-9 min-w-[150px] shrink-0 items-center justify-between rounded-lg border border-border/40 bg-custom-background-90 px-3 text-foreground transition hover:border-border/60 hover:bg-custom-background-80 focus-visible:ring-1 focus-visible:ring-primary data-[state=open]:border-primary/60"
          >
            <span className="truncate">{selected?.label}</span>
            <ChevronDown className="h-4 w-4 text-current" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48 rounded-lg border border-border/50 bg-custom-background-100 p-1"
        >
          <DropdownMenuLabel className="font-workspace px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("developerFlagsOverrideMenuLabel")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="mx-1 my-0.5 bg-border/60" />
          {options.map((option) => (
            <DropdownMenuItem
              key={String(option.value)}
              onClick={() => onOverrideChange(option.value)}
              className="font-workspace cursor-pointer rounded px-2 py-1.5 text-[13px] text-foreground"
            >
              <div className="flex w-full items-center justify-between">
                <span>{option.label}</span>
                {option.value === override ? (
                  <Check className="h-4 w-4" />
                ) : null}
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
