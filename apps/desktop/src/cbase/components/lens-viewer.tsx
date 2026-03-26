/**
 * BaseViewer - main component for viewing a .cbase file
 * Parses the .cbase definition, indexes matching files, and renders the view.
 */

import { type FC, useCallback, useEffect, useMemo, useState } from "react";
import { useProjectId } from "../../files/context/project-context";
import { useFilesStore } from "../../files/state/files-store";
import { executeView } from "../engine";
import { indexWorkspaceFiles } from "../indexer";
import { LensParseError, parseLens } from "../parser";
import { mergeInferredProperties } from "../property-inference";
import type { LensDefinition, LensFilterCondition, LensRow } from "../types";
import { BaseTable } from "./lens-table";

interface BaseViewerProps {
  /** Raw YAML content of the .cbase file */
  content: string;
  /** Relative path to the current .cbase file */
  basePath?: string;
  /** Callback to navigate to a file */
  onFileOpen?: (relativePath: string) => void;
}

export const BaseViewer: FC<BaseViewerProps> = ({
  content,
  basePath,
  onFileOpen,
}) => {
  const projectId = useProjectId();
  const { openFile, selectNode } = useFilesStore();
  const [definition, setDefinition] = useState<LensDefinition | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [rows, setRows] = useState<LensRow[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [quickFilters, setQuickFilters] = useState<LensFilterCondition[]>([]);

  // Parse .cbase content
  useEffect(() => {
    try {
      const def = parseLens(content, { basePath });
      setDefinition(def);
      setParseError(null);
      setQuickFilters([]);
      // Set default active view
      const defaultView = def.views.find((v) => v.default) ?? def.views[0];
      if (defaultView) {
        setActiveViewId(defaultView.id);
      }
    } catch (e) {
      setDefinition(null);
      setParseError(e instanceof LensParseError ? e.message : String(e));
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

  const effectiveView = useMemo(() => {
    if (!activeView) return null;
    return {
      ...activeView,
      filters: [...(activeView.filters ?? []), ...quickFilters],
    };
  }, [activeView, quickFilters]);

  const viewResult = useMemo(() => {
    if (!definition || !effectiveView) return null;
    return executeView(
      rows,
      effectiveView,
      effectiveProperties,
      definition.filters,
      definition.sort,
    );
  }, [rows, effectiveView, effectiveProperties, definition]);

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

  if (!definition || !activeView) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center text-sm text-muted-foreground font-workspace">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-90 font-workspace">
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
            definedFilters={[
              ...(definition.filters ?? []),
              ...(activeView.filters ?? []),
            ]}
            quickFilters={quickFilters}
            onQuickFiltersChange={setQuickFilters}
          />
        ) : null}
      </div>
    </div>
  );
};

// Backward-compatible export while callers migrate to BaseViewer.
export const LensViewer = BaseViewer;
