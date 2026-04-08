/**
 * BaseViewer - main component for viewing a .cbase file
 * Parses the .cbase definition, indexes matching files, and renders the view.
 */
import {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { writeProjectFile } from "@/lib/project-client";
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
import { updateViewFilters } from "../definition-updates";
import { executeView } from "../engine";
import { indexWorkspaceFiles } from "../indexer";
import { CbaseParseError, parseCbase } from "../parser";
import { mergeInferredProperties } from "../property-inference";
import { looksLikeQueryLanguage } from "../query-language";
import { serializeCbase } from "../serializer";
import type {
  CbaseDefinition,
  CbaseFilter,
  CbaseRow,
  SortDirection,
} from "../types";
import { BaseTable } from "./cbase-table";

interface BaseViewerProps {
  /** Raw YAML content of the .cbase file */
  content: string;
  /** Relative path to the current .cbase file */
  basePath?: string;
  /** Callback to navigate to a file */
  onFileOpen?: (relativePath: string) => void;
  /** Callback when view state changes require persisting the .cbase file */
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
  const [definition, setDefinition] = useState<CbaseDefinition | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rows, setRows] = useState<CbaseRow[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const isQueryLanguage = useRef(false);
  const skipNextParse = useRef(false);

  // Parse .cbase content
  useEffect(() => {
    if (skipNextParse.current) {
      skipNextParse.current = false;
      return;
    }
    try {
      isQueryLanguage.current = looksLikeQueryLanguage(content);
      const def = parseCbase(content, { basePath });
      setDefinition(def);
      setParseError(null);
      // Set default active view
      const defaultView = def.views.find((v) => v.default) ?? def.views[0];
      if (defaultView) {
        setActiveViewId(defaultView.id);
      }
    } catch (e) {
      setDefinition(null);
      setParseError(e instanceof CbaseParseError ? e.message : String(e));
    }
  }, [content, basePath]);

  // Index files when definition or file tree changes
  useEffect(() => {
    if (!definition || !projectId) return;

    let cancelled = false;
    const controller = new AbortController();

    const doIndex = async () => {
      setIsIndexing(true);
      setIndexError(null);
      try {
        const indexed = await indexWorkspaceFiles(
          projectId,
          definition.dataset,
          controller.signal,
        );
        if (!cancelled) {
          setRows(indexed);
        }
      } catch (e) {
        if (!cancelled) {
          setIndexError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setIsIndexing(false);
        }
      }
    };

    void doIndex();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [definition, projectId]);

  const activeView = useMemo(
    () =>
      definition?.views.find((v) => v.id === activeViewId) ??
      definition?.views[0] ??
      null,
    [definition, activeViewId],
  );

  const effectiveProperties = useMemo(() => {
    if (!definition) return {};
    return mergeInferredProperties(definition.properties, rows);
  }, [definition, rows]);

  const viewResult = useMemo(() => {
    if (!definition || !activeView) return null;
    return executeView(
      rows,
      activeView,
      effectiveProperties,
      definition.filters,
      definition.sort,
    );
  }, [rows, activeView, effectiveProperties, definition]);

  const persistDefinition = useCallback(
    (updated: CbaseDefinition) => {
      if (isQueryLanguage.current) return;
      const yaml = serializeCbase(updated);
      setDefinition(updated);
      skipNextParse.current = true;
      onContentChange?.(yaml);
      if (projectId && basePath) {
        void writeProjectFile(projectId, basePath, yaml);
      }
    },
    [onContentChange, projectId, basePath],
  );

  const handleColumnsChange = useCallback(
    (columnIds: string[]) => {
      if (!definition || !activeViewId) return;
      const updated: CbaseDefinition = {
        ...definition,
        properties: { ...definition.properties },
        views: definition.views.map((v) => {
          if (v.id !== activeViewId) return v;
          return {
            ...v,
            table: { ...v.table, columns: columnIds },
          };
        }),
      };
      // Add inferred properties that are now referenced as columns
      for (const colId of columnIds) {
        if (!updated.properties[colId] && effectiveProperties[colId]) {
          updated.properties[colId] = effectiveProperties[colId];
        }
      }
      persistDefinition(updated);
    },
    [definition, activeViewId, effectiveProperties, persistDefinition],
  );

  const handleSortChange = useCallback(
    (sortPropertyId: string | null, direction: SortDirection) => {
      if (!definition || !activeViewId) return;
      const updated: CbaseDefinition = {
        ...definition,
        views: definition.views.map((v) => {
          if (v.id !== activeViewId) return v;
          return {
            ...v,
            sort: sortPropertyId
              ? [{ by: sortPropertyId, dir: direction }]
              : undefined,
          };
        }),
      };
      // Add inferred property if referenced in sort
      if (
        sortPropertyId &&
        !updated.properties[sortPropertyId] &&
        effectiveProperties[sortPropertyId]
      ) {
        updated.properties = {
          ...updated.properties,
          [sortPropertyId]: effectiveProperties[sortPropertyId],
        };
      }
      persistDefinition(updated);
    },
    [definition, activeViewId, effectiveProperties, persistDefinition],
  );

  const handleColumnWidthsChange = useCallback(
    (columnWidths: Record<string, number>) => {
      if (!definition || !activeViewId) return;
      const updated: CbaseDefinition = {
        ...definition,
        views: definition.views.map((v) => {
          if (v.id !== activeViewId) return v;
          return {
            ...v,
            table: { ...v.table, column_widths: columnWidths },
          };
        }),
      };
      persistDefinition(updated);
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

  const handleViewFiltersChange = useCallback(
    (filters: CbaseFilter[]) => {
      if (!definition || !activeViewId) return;
      persistDefinition(
        updateViewFilters(
          definition,
          activeViewId,
          filters,
          effectiveProperties,
        ),
      );
    },
    [definition, activeViewId, effectiveProperties, persistDefinition],
  );

  if (parseError) {
    return (
      <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-2 p-8 text-sm font-workspace">
        <span className="font-medium text-foreground">Invalid .cbase file</span>
        <span className="text-muted-foreground">{parseError}</span>
      </div>
    );
  }

  if (!definition || !activeView) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center text-sm text-muted-foreground font-workspace">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-100 font-workspace">
      <div className="min-h-0 flex-1 overflow-hidden">
        {isIndexing && rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Indexing files...
          </div>
        ) : indexError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm">
            <span className="font-medium text-foreground">
              Failed to index files
            </span>
            <span className="text-muted-foreground">{indexError}</span>
          </div>
        ) : viewResult ? (
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
        ) : null}
      </div>
    </div>
  );
};
