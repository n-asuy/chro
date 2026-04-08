import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { useFileTreeStore } from "../state/file-tree-store";
import { useFilesStore } from "../state/files-store";

function isCbasePath(path: string | null): boolean {
  return Boolean(path?.toLowerCase().endsWith(".cbase"));
}

/**
 * One-way sync: URL ?path= → Zustand store.
 *
 * When the URL search parameter changes (initial load, back/forward,
 * or programmatic navigate), this effect opens the corresponding file
 * in the store and expands/selects it in the tree.
 *
 * The reverse direction (store → URL) is handled by a navigate callback
 * registered in the store. openFile/closeFile call it automatically,
 * so there is no second effect and no bidirectional loop to guard against.
 */
export function useFileUrlSync() {
  const search = useSearch({ strict: false }) as { path?: string };
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const selectNode = useFilesStore((state) => state.selectNode);
  const fileTree = useFilesStore((state) => state.fileTree);
  const expandToPath = useFileTreeStore((state) => state.expandToPath);

  const previousPathRef = useRef<string | null>(null);

  // Register navigate callback so openFile/closeFile can update the URL.
  const navigateToFile = useCallback(
    (path: string | null) => {
      const prev = previousPathRef.current;
      previousPathRef.current = path;
      const shouldPush = isCbasePath(prev) || isCbasePath(path);

      if (path) {
        const pathValue = path.startsWith("/") ? path.slice(1) : path;
        navigate({
          to: pathname,
          search: { path: pathValue },
          replace: !shouldPush,
        });
      } else {
        navigate({ to: pathname, search: {}, replace: !shouldPush });
      }
    },
    [navigate, pathname],
  );

  useEffect(() => {
    useFilesStore.setState({ _onFilePathChange: navigateToFile });
    return () => useFilesStore.setState({ _onFilePathChange: null });
  }, [navigateToFile]);

  // URL → store: sync ?path= into currentFilePath, expand tree, select node.
  // Sets currentFilePath directly (not via openFile) to avoid re-triggering navigate.
  useEffect(() => {
    if (fileTree.length === 0) return;

    const fileParam = search.path?.trim();
    if (!fileParam) {
      const { currentFilePath } = useFilesStore.getState();
      if (currentFilePath !== null) {
        useFilesStore.setState({ currentFilePath: null });
      }
      return;
    }

    const normalizedPath = fileParam.startsWith("/")
      ? fileParam
      : `/${fileParam}`;

    const { currentFilePath } = useFilesStore.getState();
    if (normalizedPath === currentFilePath) return;

    expandToPath(normalizedPath);
    selectNode(normalizedPath);
    useFilesStore.setState({ currentFilePath: normalizedPath });
  }, [search.path, fileTree.length, expandToPath, selectNode]);
}
