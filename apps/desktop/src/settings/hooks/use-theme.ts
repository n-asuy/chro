import { useEffect } from "react";
import { useEditorConfigStore } from "../state/editor-config-store";
import type { AppTheme } from "@/lib/preferences-client";

const THEME_TO_DATA_ATTR: Record<AppTheme, string> = {
  light: "light",
  dark: "dark",
};

function themeDataAttr(theme: AppTheme): string {
  return THEME_TO_DATA_ATTR[theme] ?? "light";
}

/**
 * Loads the editor config on mount and applies data-theme to the root element.
 * Should be called once near the top of the component tree.
 */
export function useTheme() {
  const theme = useEditorConfigStore((s) => s.config.theme);
  const load = useEditorConfigStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const attr = themeDataAttr(theme);
    document.documentElement.setAttribute("data-theme", attr);
  }, [theme]);

  return { theme, dataTheme: themeDataAttr(theme) };
}
