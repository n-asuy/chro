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
import { useCallback, useEffect, useRef, useState } from "react";
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

/** Swatch shown when no custom accent is set (the built-in brand). */
const BRAND_DEFAULT_ACCENT = "#0c6cbe";
/** Coalesce rapid picker drags into a single save + derivation. */
const ACCENT_COMMIT_DELAY_MS = 160;

export function AppearancePane() {
  const { t } = useLanguage();
  const theme = useAppearanceConfigStore((s) => s.config.theme);
  const accent = useAppearanceConfigStore((s) => s.config.accent);
  const loaded = useAppearanceConfigStore((s) => s.loaded);
  const load = useAppearanceConfigStore((s) => s.load);
  const update = useAppearanceConfigStore((s) => s.update);

  // Local draft drives the swatch during interaction. It is intentionally NOT
  // re-synced from `config.accent`, so an optimistic echo or rollback can't
  // clobber an in-flight pick. `null` means "follow the persisted value".
  const [draft, setDraft] = useState<string | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayAccent = draft ?? accent ?? BRAND_DEFAULT_ACCENT;

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  useEffect(
    () => () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    },
    [],
  );

  const handlePickAccent = useCallback(
    (value: string) => {
      setDraft(value);
      if (commitTimer.current) clearTimeout(commitTimer.current);
      // Debounced commit: the store guards against stale out-of-order echoes,
      // and use-theme re-derives the live UI from the optimistic value.
      commitTimer.current = setTimeout(() => {
        void update({ accent: value });
      }, ACCENT_COMMIT_DELAY_MS);
    },
    [update],
  );

  const handleResetAccent = useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    setDraft(null);
    void update({ accent: null });
  }, [update]);

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
        <SettingsRow
          title={t("appearanceAccentTitle")}
          description={t("appearanceAccentDescription")}
          control={
            <div className="flex items-center gap-2">
              <label
                className="relative inline-flex h-9 w-9 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-border/40 transition hover:border-border/60"
                title={displayAccent}
              >
                <span
                  className="absolute inset-0"
                  style={{ backgroundColor: displayAccent }}
                />
                <input
                  type="color"
                  value={displayAccent}
                  onChange={(event) => handlePickAccent(event.target.value)}
                  aria-label={t("appearanceAccentTitle")}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </label>
              {accent ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleResetAccent}
                  className="font-workspace h-9 rounded-lg px-3 text-[13px] text-muted-foreground transition hover:text-foreground"
                >
                  {t("appearanceAccentReset")}
                </Button>
              ) : null}
            </div>
          }
        />
      </SettingsSection>
    </section>
  );
}
