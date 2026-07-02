/**
 * BaseViewer - main component for viewing a .cbase file.
 *
 * Parsing, indexing, schema inference, and view execution all run on the
 * backend. This component fetches the materialized document, renders the active
 * view, and sends UI-driven changes back for the backend to persist.
 */
import {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useProjectId } from "../../files/context/project-context";
import { useFilesStore } from "../../files/state/files-store";
import { persistCbase, queryCbase } from "../cbase-client";
import type {
  CbaseDefinition,
  CbaseDocument,
  CbaseFilter,
  SortDirection,
} from "../types";
import { BaseTable } from "./cbase-table";

interface BaseViewerProps {
  /** Raw content of the .cbase file (YAML or query language) */
  content: string;
  /** Relative path to the current .cbase file */
  basePath?: string;
  /** Callback to navigate to a file */
  onFileOpen?: (relativePath: string) => void;
  /** Callback when view state changes require updating the editor content */
  onContentChange?: (content: string) => void;
}

export const BaseViewer: FC<BaseViewerProps> = ({
  content,
  basePath,
  onFileOpen,
  onContentChange,
}) => {
  const projectId = useProjectId();
  const { openFile, selectNode } = useFilesStore();
  const [document, setDocument] = useState<CbaseDocument | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  // Set after a persist so the resulting content change does not re-query.
  const skipNextQuery = useRef(false);

  // Fetch the materialized document whenever the source content changes.
  useEffect(() => {
    if (!projectId) return;
    if (skipNextQuery.current) {
      skipNextQuery.current = false;
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    queryCbase(projectId, content, basePath)
      .then((doc) => {
        if (cancelled) return;
        if (doc.parseError) {
          setParseError(doc.parseError);
          setDocument(null);
          return;
        }
        setParseError(null);
        setDocument(doc);
        setActiveViewId((prev) => {
          const views = doc.definition?.views ?? [];
          if (prev && views.some((view) => view.id === prev)) return prev;
          const fallback = views.find((view) => view.default) ?? views[0];
          return fallback?.id ?? null;
        });
      })
      .catch((e) => {
        if (!cancelled)
          setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [content, basePath, projectId]);

  const definition = document?.definition ?? null;

  const activeView = useMemo(() => {
    if (!definition) return null;
    return (
      definition.views.find((view) => view.id === activeViewId) ??
      definition.views[0] ??
      null
    );
  }, [definition, activeViewId]);

  const effectiveProperties = document?.properties ?? {};

  const viewResult = useMemo(() => {
    if (!document || !activeView) return null;
    return (
      document.views.find((result) => result.view.id === activeView.id) ?? null
    );
  }, [document, activeView]);

  const persistDefinition = useCallback(
    (updated: CbaseDefinition) => {
      if (!document || document.isQueryLanguage) return;
      if (!projectId || !basePath) return;
      skipNextQuery.current = true;
      // Optimistically reflect the definition change in the editor.
      setDocument({ ...document, definition: updated });
      persistCbase(projectId, basePath, updated, effectiveProperties)
        .then((result) => {
          setDocument(result.document);
          onContentChange?.(result.content);
        })
        .catch((e) => {
          skipNextQuery.current = false;
          setLoadError(e instanceof Error ? e.message : String(e));
        });
    },
    [document, projectId, basePath, effectiveProperties, onContentChange],
  );

  const handleColumnsChange = useCallback(
    (columnIds: string[]) => {
      if (!definition || !activeViewId) return;
      persistDefinition({
        ...definition,
        views: definition.views.map((view) =>
          view.id === activeViewId
            ? { ...view, table: { ...view.table, columns: columnIds } }
            : view,
        ),
      });
    },
    [definition, activeViewId, persistDefinition],
  );

  const handleSortChange = useCallback(
    (sortPropertyId: string | null, direction: SortDirection) => {
      if (!definition || !activeViewId) return;
      persistDefinition({
        ...definition,
        views: definition.views.map((view) =>
          view.id === activeViewId
            ? {
                ...view,
                sort: sortPropertyId
                  ? [{ by: sortPropertyId, dir: direction }]
                  : undefined,
              }
            : view,
        ),
      });
    },
    [definition, activeViewId, persistDefinition],
  );

  const handleColumnWidthsChange = useCallback(
    (columnWidths: Record<string, number>) => {
      if (!definition || !activeViewId) return;
      persistDefinition({
        ...definition,
        views: definition.views.map((view) =>
          view.id === activeViewId && view.table
            ? { ...view, table: { ...view.table, column_widths: columnWidths } }
            : view,
        ),
      });
    },
    [definition, activeViewId, persistDefinition],
  );

  const handleViewFiltersChange = useCallback(
    (filters: CbaseFilter[]) => {
      if (!definition || !activeViewId) return;
      const nextFilters = filters.length > 0 ? filters : undefined;
      persistDefinition({
        ...definition,
        views: definition.views.map((view) =>
          view.id === activeViewId ? { ...view, filters: nextFilters } : view,
        ),
      });
    },
    [definition, activeViewId, persistDefinition],
  );

  const handleRowClick = useCallback(
    (filePath: string) => {
      if (onFileOpen) {
        onFileOpen(filePath);
      } else {
        const normalizedPath = filePath.startsWith("/")
          ? filePath
          : `/${filePath}`;
        selectNode(normalizedPath);
        openFile(normalizedPath);
      }
    },
    [onFileOpen, selectNode, openFile],
  );

  if (parseError) {
    return (
      <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-2 p-8 text-sm font-workspace">
        <span className="font-medium text-foreground">Invalid .cbase file</span>
        <span className="text-muted-foreground">{parseError}</span>
      </div>
    );
  }

  if (isLoading && !document) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center text-sm text-muted-foreground font-workspace">
        Loading...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm font-workspace">
        <span className="font-medium text-foreground">
          Failed to load .cbase
        </span>
        <span className="text-muted-foreground">{loadError}</span>
      </div>
    );
  }

  if (!definition || !activeView || !viewResult) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center text-sm text-muted-foreground font-workspace">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-100 font-workspace">
      <div className="min-h-0 flex-1 overflow-hidden">
        <BaseTable
          rows={viewResult.rows}
          totalCount={viewResult.totalCount}
          view={activeView}
          properties={effectiveProperties}
          onRowClick={handleRowClick}
          definedFilters={definition.filters ?? []}
          viewFilters={activeView.filters ?? []}
          onViewFiltersChange={handleViewFiltersChange}
          onColumnsChange={handleColumnsChange}
          onSortChange={handleSortChange}
          onColumnWidthsChange={handleColumnWidthsChange}
        />
      </div>
    </div>
  );
};
