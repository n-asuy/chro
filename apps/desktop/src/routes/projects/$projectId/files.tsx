import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useFilesStore } from "@/files/state/files-store";
import { useLayoutStore } from "@/workspace-layout/state/layout-store";

type FilesSearchParams = {
  path?: string;
};

export const Route = createFileRoute("/projects/$projectId/files")({
  validateSearch: (search: Record<string, unknown>): FilesSearchParams => ({
    path: typeof search.path === "string" ? search.path : undefined,
  }),
  component: FilesPage,
});

/**
 * Bridge route. The visual surface lives in `LayoutShell`. When a `?path=`
 * search param is present we open it as a file tab in the focused pane.
 */
function FilesPage() {
  const search = useSearch({ from: Route.id }) as FilesSearchParams;
  const currentFilePath = useFilesStore((s) => s.currentFilePath);
  const openTab = useLayoutStore((s) => s.openTab);
  const fileName = useMemo(() => {
    if (!currentFilePath) return null;
    return currentFilePath.split("/").pop() ?? null;
  }, [currentFilePath]);
  useDocumentTitle(fileName);

  useEffect(() => {
    if (search.path) {
      openTab({ type: "file", path: search.path }, { activate: true });
    }
  }, [search.path, openTab]);

  return null;
}
