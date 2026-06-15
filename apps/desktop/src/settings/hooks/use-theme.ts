import { useEffect, useState } from "react";
import type { AppTheme } from "@/lib/preferences-client";
import { useAppearanceConfigStore } from "../state/appearance-store";

type ResolvedTheme = "light" | "dark";

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function resolveDataTheme(
  theme: AppTheme,
  prefersDark: boolean,
): ResolvedTheme {
  if (theme === "system") {
    return prefersDark ? "dark" : "light";
  }
  return theme === "dark" ? "dark" : "light";
}

/**
 * Loads the appearance config on mount and applies the resolved data-theme to
 * the root element. The `system` theme follows the OS light/dark preference and
 * reacts to live changes. Should be called once near the top of the tree.
 */
export function useTheme() {
  const theme = useAppearanceConfigStore((s) => s.config.theme);
  const load = useAppearanceConfigStore((s) => s.load);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };
    setPrefersDark(media.matches);
    media.addEventListener("change", handler);
    return () => {
      media.removeEventListener("change", handler);
    };
  }, []);

  const dataTheme = resolveDataTheme(theme, prefersDark);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dataTheme);
  }, [dataTheme]);

  return { theme, dataTheme };
}
