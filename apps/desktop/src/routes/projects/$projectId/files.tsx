import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useFilesStore } from "@/files/state/files-store";
import FilesLayout from "@/files";

type FilesSearchParams = {
  path?: string;
};

export const Route = createFileRoute("/projects/$projectId/files")({
  validateSearch: (search: Record<string, unknown>): FilesSearchParams => ({
    path: typeof search.path === "string" ? search.path : undefined,
  }),
  component: FilesPage,
});

function FilesPage() {
  const currentFilePath = useFilesStore((s) => s.currentFilePath);
  const fileName = useMemo(() => {
    if (!currentFilePath) return null;
    return currentFilePath.split("/").pop() ?? null;
  }, [currentFilePath]);
  useDocumentTitle(fileName);

  useEffect(() => {
    window.desktop?.setWindowMode?.("session");
  }, []);

  return <FilesLayout />;
}
