import { type TranslationKey, useLanguage } from "@/i18n";
import type { AppTheme } from "@/lib/preferences-client";
import { Button } from "@chro/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { useEffect } from "react";
import { SettingsRow } from "../components/settings-row";
import { SettingsSection } from "../components/settings-section";
import { useAppearanceConfigStore } from "../state/appearance-store";

const THEME_OPTIONS: Array<{ value: AppTheme; labelKey: TranslationKey }> = [
  { value: "system", labelKey: "appearanceThemeSystem" },
  { value: "light", labelKey: "appearanceThemeLight" },
  { value: "dark", labelKey: "appearanceThemeDark" },
];

const THEME_LABEL_KEYS: Record<AppTheme, TranslationKey> = {
  system: "appearanceThemeSystem",
  light: "appearanceThemeLight",
  dark: "appearanceThemeDark",
};

export function AppearancePane() {
  const { t } = useLanguage();
  const theme = useAppearanceConfigStore((s) => s.config.theme);
  const loaded = useAppearanceConfigStore((s) => s.loaded);
  const load = useAppearanceConfigStore((s) => s.load);
  const update = useAppearanceConfigStore((s) => s.update);

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("appearanceSettingsTitle")}
        </h2>
        <p className="font-workspace text-[13px] text-muted-foreground mt-1">
          {t("appearanceSettingsDescription")}
        </p>
      </div>

      <SettingsSection>
        <SettingsRow
          title={t("appearanceThemeTitle")}
          description={t("appearanceThemeDescription")}
          control={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="font-workspace text-[13px] flex h-9 min-w-[180px] items-center justify-between rounded-lg border border-border/40 bg-custom-background-90 px-3 text-foreground transition hover:border-border/60 hover:bg-custom-background-80 focus-visible:ring-1 focus-visible:ring-primary data-[state=open]:border-primary/60"
                >
                  <span className="truncate">{t(THEME_LABEL_KEYS[theme])}</span>
                  <ChevronDown className="h-4 w-4 text-current" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-[220px] rounded-lg border border-border/50 bg-custom-background-100 p-1"
              >
                <DropdownMenuLabel className="font-workspace px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("appearanceThemeTitle")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="mx-1 my-0.5 bg-border/60" />
                {THEME_OPTIONS.map((option) => {
                  const isActive = option.value === theme;
                  return (
                    <DropdownMenuItem
                      key={option.value}
                      onClick={() => void update({ theme: option.value })}
                      className="font-workspace cursor-pointer rounded px-2 py-1.5 text-[13px] text-foreground"
                    >
                      <div className="flex w-full items-center justify-between">
                        <span>{t(option.labelKey)}</span>
                        {isActive ? <Check className="h-4 w-4" /> : null}
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      </SettingsSection>
    </section>
  );
}
