import { useEffect } from "react";
import { useOptionalProjectContext } from "@/files/context/project-context";

const DEFAULT_TITLE = "Chro";

/**
 * Sets `document.title` to the given value, prefixed with the workspace name.
 * Electron mirrors `document.title` into the window title bar automatically.
 * Pass `null` or `undefined` to reset to the default app name.
 *
 * Examples:
 *   useDocumentTitle("settings.tsx") → "chro | settings.tsx"
 *   useDocumentTitle(null)           → "chro"
 *   (no project context)             → "Chro"
 */
export function useDocumentTitle(title: string | null | undefined) {
  const projectContext = useOptionalProjectContext();
  const projectName = projectContext?.project?.name ?? null;

  useEffect(() => {
    const trimmed = title?.trim();
    if (projectName) {
      document.title = trimmed ? `${projectName} | ${trimmed}` : projectName;
    } else {
      document.title = trimmed || DEFAULT_TITLE;
    }
    return () => {
      document.title = projectName || DEFAULT_TITLE;
    };
  }, [title, projectName]);
}
