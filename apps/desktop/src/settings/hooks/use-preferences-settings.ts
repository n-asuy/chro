import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchPreferences,
  savePreferences as savePreferencesRequest,
} from "@/lib/preferences-client";
import { setAnalyticsEnabled } from "@/lib/analytics";
import { dispatchWorkspaceRefreshEvent } from "@/lib/preferences-events";
import type { SupportedLanguage, TranslationFunction } from "@/i18n";

type LanguageOption = SupportedLanguage;

type PreferencesState = {
  language: LanguageOption;
  showHiddenEntries: boolean;
  analyticsEnabled: boolean;
  preferencesLoading: boolean;
  preferencesError: string | null;
  preferencesParseWarning: string | null;
  preferencesSaveState: "idle" | "saving" | "success" | "error";
  preferencesSaveError: string | null;
  preferencesDirty: boolean;
  handleLanguageSelect: (value: string) => void;
  handleHiddenToggle: (checked: boolean) => void;
  handleAnalyticsToggle: (checked: boolean) => void;
};

type PreferencesSettingsArgs = {
  activeLanguage: SupportedLanguage;
  setAppLanguage: (language: SupportedLanguage) => void;
  t: TranslationFunction;
};

export function usePreferencesSettings({
  activeLanguage,
  setAppLanguage,
  t,
}: PreferencesSettingsArgs): PreferencesState {
  const [language, setLanguage] = useState<LanguageOption>(activeLanguage);
  const [initialLanguage, setInitialLanguage] =
    useState<LanguageOption>(activeLanguage);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [preferencesParseWarning, setPreferencesParseWarning] = useState<
    string | null
  >(null);
  const [preferencesSaveState, setPreferencesSaveState] = useState<
    "idle" | "saving" | "success" | "error"
  >("idle");
  const [preferencesSaveError, setPreferencesSaveError] = useState<
    string | null
  >(null);
  const [showHiddenEntries, setShowHiddenEntries] = useState(false);
  const [initialShowHiddenEntries, setInitialShowHiddenEntries] =
    useState(false);
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(true);
  const hasLoadedPreferencesRef = useRef(false);

  const preferencesDirty =
    language !== initialLanguage ||
    showHiddenEntries !== initialShowHiddenEntries;

  const loadPreferences = useCallback(
    async (options?: { force?: boolean }) => {
      if (hasLoadedPreferencesRef.current && !options?.force) {
        return;
      }
      hasLoadedPreferencesRef.current = true;

      setPreferencesLoading(true);
      setPreferencesError(null);
      setPreferencesSaveState("idle");
      setPreferencesSaveError(null);

      try {
        const response = await fetchPreferences();
        const nextLanguage: LanguageOption =
          response.preferences.language === "ja" ? "ja" : "en";
        const nextHidden = Boolean(response.preferences.show_hidden_entries);
        const nextAnalytics = response.preferences.analytics_enabled !== false;
        setLanguage(nextLanguage);
        setInitialLanguage(nextLanguage);
        setAppLanguage(nextLanguage);
        setShowHiddenEntries(nextHidden);
        setInitialShowHiddenEntries(nextHidden);
        setAnalyticsEnabledState(nextAnalytics);
        setPreferencesParseWarning(null);
      } catch (error) {
        setPreferencesError(
          error instanceof Error
            ? error.message
            : t("preferencesLoadErrorDescription"),
        );
      } finally {
        setPreferencesLoading(false);
      }
    },
    [setAppLanguage, t],
  );

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const handleLanguageSelect = useCallback(
    (value: string) => {
      if (value !== "ja" && value !== "en") return;
      const next = value as LanguageOption;
      setLanguage(next);
      setPreferencesParseWarning(null);
      setAppLanguage(next);

      setPreferencesSaveState("saving");
      setPreferencesSaveError(null);

      void (async () => {
        try {
          const response = await savePreferencesRequest({
            language: next,
            show_hidden_entries: showHiddenEntries,
          });
          const savedLanguage: LanguageOption =
            response.preferences.language === "ja" ? "ja" : "en";
          const savedHidden = Boolean(response.preferences.show_hidden_entries);
          setLanguage(savedLanguage);
          setInitialLanguage(savedLanguage);
          setPreferencesParseWarning(null);
          setAppLanguage(savedLanguage);
          setShowHiddenEntries(savedHidden);
          setInitialShowHiddenEntries(savedHidden);
          setPreferencesSaveState("success");
          setTimeout(() => setPreferencesSaveState("idle"), 2000);
        } catch (error) {
          console.error("[settings] failed to persist language", error);
          setPreferencesSaveState("error");
          setPreferencesSaveError(
            error instanceof Error
              ? error.message
              : t("preferencesSaveErrorDescription"),
          );
          void loadPreferences({ force: true });
        }
      })();
    },
    [loadPreferences, setAppLanguage, showHiddenEntries, t],
  );

  useEffect(() => {
    if (!preferencesDirty) {
      setLanguage(activeLanguage);
      setInitialLanguage(activeLanguage);
    }
  }, [activeLanguage, preferencesDirty]);

  const handleHiddenToggle = useCallback(
    (checked: boolean) => {
      const nextValue = Boolean(checked);
      setShowHiddenEntries(nextValue);
      setPreferencesParseWarning(null);
      setPreferencesSaveState("saving");
      setPreferencesSaveError(null);

      void (async () => {
        try {
          const response = await savePreferencesRequest({
            language,
            show_hidden_entries: nextValue,
          });
          const savedLanguage: LanguageOption =
            response.preferences.language === "ja" ? "ja" : "en";
          const savedHidden = Boolean(response.preferences.show_hidden_entries);
          setLanguage(savedLanguage);
          setInitialLanguage(savedLanguage);
          setAppLanguage(savedLanguage);
          setShowHiddenEntries(savedHidden);
          setInitialShowHiddenEntries(savedHidden);
          dispatchWorkspaceRefreshEvent();
          setPreferencesSaveState("success");
          setTimeout(() => setPreferencesSaveState("idle"), 2000);
        } catch (error) {
          console.error("[settings] failed to persist hidden entries", error);
          setPreferencesSaveState("error");
          setPreferencesSaveError(
            error instanceof Error
              ? error.message
              : t("preferencesSaveErrorDescription"),
          );
          void loadPreferences({ force: true });
        }
      })();
    },
    [language, loadPreferences, setAppLanguage, t],
  );

  const handleAnalyticsToggle = useCallback(
    (checked: boolean) => {
      const nextValue = Boolean(checked);
      setAnalyticsEnabledState(nextValue);
      setAnalyticsEnabled(nextValue);
      setPreferencesSaveState("saving");
      setPreferencesSaveError(null);

      void (async () => {
        try {
          await savePreferencesRequest({
            language,
            analytics_enabled: nextValue,
          });
          setPreferencesSaveState("success");
          setTimeout(() => setPreferencesSaveState("idle"), 2000);
        } catch (error) {
          console.error("[settings] failed to persist analytics toggle", error);
          setPreferencesSaveState("error");
          setPreferencesSaveError(
            error instanceof Error
              ? error.message
              : t("preferencesSaveErrorDescription"),
          );
          void loadPreferences({ force: true });
        }
      })();
    },
    [language, loadPreferences, t],
  );

  return {
    language,
    showHiddenEntries,
    analyticsEnabled,
    preferencesLoading,
    preferencesError,
    preferencesParseWarning,
    preferencesSaveState,
    preferencesSaveError,
    preferencesDirty,
    handleLanguageSelect,
    handleHiddenToggle,
    handleAnalyticsToggle,
  };
}
