import { fetchPreferences } from "@/lib/preferences-client";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import en from "./locales/en";
import ja, { type TranslationDictionary } from "./locales/ja";

export type SupportedLanguage = "ja" | "en";

export type TranslationKey = keyof TranslationDictionary;

export type TranslationFunction = (
  key: TranslationKey,
  replacements?: Record<string, string | number>,
) => string;

const TRANSLATIONS: Record<SupportedLanguage, TranslationDictionary> = {
  ja,
  en,
};

type LanguageContextValue = {
  language: SupportedLanguage;
  setLanguage: (language: SupportedLanguage) => void;
  t: TranslationFunction;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

function applyReplacements(
  template: string,
  replacements: Record<string, string | number> | undefined,
): string {
  if (!replacements) return template;
  return Object.entries(replacements).reduce((acc, [key, value]) => {
    const pattern = new RegExp(`{${key}}`, "g");
    return acc.replace(pattern, String(value));
  }, template);
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<SupportedLanguage>("en");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetchPreferences();
        if (!cancelled) {
          const next = response.preferences.language === "ja" ? "ja" : "en";
          setLanguageState(next);
        }
      } catch {
        // Ignore errors; default language will be used.
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLanguage = useCallback((next: SupportedLanguage) => {
    setLanguageState(next);
  }, []);

  const t = useCallback<TranslationFunction>(
    (key, replacements) => {
      const dictionary = TRANSLATIONS[language] ?? TRANSLATIONS.en;
      const template = dictionary[key] ?? TRANSLATIONS.en[key] ?? key;
      return applyReplacements(template, replacements);
    },
    [language],
  );

  const value = useMemo<LanguageContextValue>(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}

/**
 * Like {@link useLanguage} but returns null instead of throwing when no
 * provider is mounted. Used by the global error boundary, which can render
 * above the LanguageProvider (e.g. when a provider itself throws).
 */
export function useOptionalLanguage(): LanguageContextValue | null {
  return useContext(LanguageContext);
}
