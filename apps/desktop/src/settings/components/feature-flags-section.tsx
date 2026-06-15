import { useLanguage } from "@/i18n";
import { isOverridden, useFeatureFlagStore } from "@/lib/feature-flags-store";
import { Alert, AlertDescription } from "@chro/ui/alert";
import { Badge } from "@chro/ui/badge";
import { Button } from "@chro/ui/button";
import { Switch } from "@chro/ui/switch";
import { useEffect } from "react";
import { SettingsSection } from "./settings-section";

function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ");
}

/**
 * Developer-only panel to inspect the feature-flag registry and override flags
 * locally. The registry comes from the backend (the code-owned source of
 * truth); overrides are stored per-installation and never touch PostHog.
 */
export function FeatureFlagsSection() {
  const { t } = useLanguage();
  const registry = useFeatureFlagStore((s) => s.registry);
  const resolved = useFeatureFlagStore((s) => s.resolved);
  const overrides = useFeatureFlagStore((s) => s.overrides);
  const error = useFeatureFlagStore((s) => s.error);
  const load = useFeatureFlagStore((s) => s.load);
  const setOverride = useFeatureFlagStore((s) => s.setOverride);
  const clearOverride = useFeatureFlagStore((s) => s.clearOverride);
  const clearAllOverrides = useFeatureFlagStore((s) => s.clearAllOverrides);

  useEffect(() => {
    if (!useFeatureFlagStore.getState().loaded) {
      void load();
    }
  }, [load]);

  const hasAnyOverride = Object.keys(overrides).length > 0;

  return (
    <SettingsSection
      heading={t("developerFlagsTitle")}
      action={
        hasAnyOverride ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => clearAllOverrides()}
            className="font-workspace text-[13px] text-muted-foreground hover:text-foreground"
          >
            {t("developerFlagsResetAll")}
          </Button>
        ) : undefined
      }
    >
      <div className="px-5 py-3">
        <p className="font-workspace text-[12px] text-muted-foreground">
          {t("developerFlagsDescription")}
        </p>
      </div>

      {error ? (
        <div className="px-5 py-3">
          <Alert
            variant="destructive"
            className="border-destructive/40 bg-destructive/10"
          >
            <AlertDescription>{t("developerFlagsLoadError")}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {registry.length === 0 ? (
        <div className="font-workspace px-5 py-4 text-[12px] text-muted-foreground">
          {t("developerFlagsEmpty")}
        </div>
      ) : (
        registry.map((flag) => {
          const overridden = isOverridden(overrides, flag.key);
          const effective = overridden
            ? overrides[flag.key]
            : resolved[flag.key] ?? flag.resolved_value;

          return (
            <div
              key={flag.key}
              className="flex items-start justify-between gap-4 px-5 py-4"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-workspace text-[13px] text-foreground">
                    {flag.key}
                  </code>
                  <Badge
                    variant="secondary"
                    className="font-workspace text-[10px] uppercase tracking-wide"
                  >
                    {humanizeStatus(flag.status)}
                  </Badge>
                  {overridden ? (
                    <Badge className="font-workspace border-amber-500/40 bg-amber-500/20 text-[10px] uppercase tracking-wide text-amber-600">
                      {t("developerFlagsOverridden")}
                    </Badge>
                  ) : null}
                </div>
                <p className="font-workspace text-[12px] text-muted-foreground">
                  {flag.description}
                </p>
                <span className="font-workspace text-[11px] text-muted-foreground">
                  {t("developerFlagsMeta", {
                    owner: flag.owner,
                    date: flag.retire_by,
                  })}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {overridden ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => clearOverride(flag.key)}
                    className="font-workspace text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {t("developerFlagsReset")}
                  </Button>
                ) : null}
                <Switch
                  checked={effective}
                  onCheckedChange={(value) => setOverride(flag.key, value)}
                  aria-label={flag.key}
                />
              </div>
            </div>
          );
        })
      )}
    </SettingsSection>
  );
}
