import type { AppTheme } from "@/lib/preferences-client";
import { useEffect, useState } from "react";
import { applyAccentVars } from "../lib/accent-apply";
import { deriveAccentVarsSafe } from "../lib/accent-derivation";
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
  const accent = useAppearanceConfigStore((s) => s.config.accent);
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
    const root = document.documentElement;
    // Suppress transitions across the flip so the whole UI repaints to the new
    // theme in one frame (see the [data-theme-switching] rule in globals.css),
    // then re-enable on the next frame once the new theme has painted.
    root.setAttribute("data-theme-switching", "");
    root.setAttribute("data-theme", dataTheme);
    // Apply the accent in the same frame as the theme flip: the ramp is
    // re-derived for the resolved mode so it stays legible, and an accent-only
    // change snaps instead of crossfading. A null seed clears the overrides and
    // falls back to the static globals.css brand defaults.
    applyAccentVars(
      root,
      accent ? deriveAccentVarsSafe(accent, dataTheme) : null,
    );
    const raf = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        root.removeAttribute("data-theme-switching");
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [dataTheme, accent]);

  return { theme, dataTheme };
}
