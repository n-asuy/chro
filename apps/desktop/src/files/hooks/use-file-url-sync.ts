import { useEffect, useRef } from "react";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useFilesStore } from "../state/files-store";
import { useFileTreeStore } from "../state/file-tree-store";

function isCbasePath(path: string | null): boolean {
  return Boolean(path && path.toLowerCase().endsWith(".cbase"));
}

/**
 * Syncs the current file path with URL query parameter (?path=...).
 *
 * - On mount: reads ?path= parameter and opens that file
 * - On URL path change: opens the newly specified file
 * - On file change: updates URL with new file path
 * - Supports direct linking: /projects/[id]/files?path=/path/to/file.md
 */
export function useFileUrlSync() {
  const search = useSearch({ strict: false }) as { path?: string };
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const currentFilePath = useFilesStore((state) => state.currentFilePath);
  const openFile = useFilesStore((state) => state.openFile);
  const selectNode = useFilesStore((state) => state.selectNode);
  const fileTree = useFilesStore((state) => state.fileTree);
  const expandToPath = useFileTreeStore((state) => state.expandToPath);

  const hasInitializedFromUrl = useRef(false);
  const lastSyncedPath = useRef<string | null>(null);

  // On tree load and URL changes: open file specified by ?path=
  useEffect(() => {
    if (fileTree.length === 0) return;

    if (!hasInitializedFromUrl.current) {
      hasInitializedFromUrl.current = true;
    }

    const fileParam = search.path?.trim();
    if (!fileParam) return;

    const normalizedPath = fileParam.startsWith("/")
      ? fileParam
      : `/${fileParam}`;

    // Ignore if already on the same file
    if (normalizedPath === currentFilePath) {
      lastSyncedPath.current = normalizedPath;
      return;
    }

    expandToPath(normalizedPath);
    selectNode(normalizedPath);
    openFile(normalizedPath);
    lastSyncedPath.current = normalizedPath;
  }, [
    currentFilePath,
    expandToPath,
    fileTree.length,
    openFile,
    search.path,
    selectNode,
  ]);

  // On file change: update URL
  useEffect(() => {
    // Don't update URL until initial sync is complete
    if (!hasInitializedFromUrl.current) return;

    // Skip if this is the same path we just synced
    if (currentFilePath === lastSyncedPath.current) return;
    const previousPath = lastSyncedPath.current;
    lastSyncedPath.current = currentFilePath;
    const shouldPushHistory =
      isCbasePath(previousPath) || isCbasePath(currentFilePath);

    // Build new search params
    if (currentFilePath) {
      // Remove leading slash for cleaner URLs
      const pathValue = currentFilePath.startsWith("/")
        ? currentFilePath.slice(1)
        : currentFilePath;

      navigate({
        to: pathname,
        search: { path: pathValue },
        replace: !shouldPushHistory,
      });
    } else {
      navigate({
        to: pathname,
        search: {},
        replace: !shouldPushHistory,
      });
    }
  }, [currentFilePath, pathname, navigate]);
}
