import { useRepoEvents } from "@/hooks/use-repo-events";
import { writeProjectFile } from "@/lib/project-client";
/**
 * BaseViewer - main component for viewing a .cbase file.
 *
 * Parsing, indexing, schema inference, and view execution all run on the
 * backend. This component fetches the materialized document, renders the
 * active view with an optimistic frontmatter overlay for inline edits, and
 * sends UI-driven changes back for the backend to persist. Watcher-driven
 * refreshes are held while a cell editor is open so rows cannot move under
 * the user's edit.
 */
import { toast } from "@chro/ui/hooks/use-toast";
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
import { persistCbase, queryCbase, setCbaseProperty } from "../cbase-client";
import { getCachedDocument, setCachedDocument } from "../cbase-document-cache";
import type {
  CbaseDefinition,
  CbaseDocument,
  CbaseFilter,
  CbaseRow,
  SortDirection,
} from "../types";
import {
  type PropertyOverlay,
  applyOverlay,
  createDatasetPathFilter,
  datasetFolder,
  newNoteContent,
  nextUntitledPath,
  overlayKey,
  settleOverlay,
} from "../view-model";
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

const CBASE_PAGE_SIZE = 250;
const CBASE_REFRESH_SETTLE_MS = 250;

const allDocumentRows = (doc: CbaseDocument): CbaseRow[] =>
  doc.views.flatMap((result) => result.rows);

const mergeDocumentPage = (
  current: CbaseDocument | null,
  page: CbaseDocument,
): CbaseDocument => {
  const incoming = page.views[0];
  if (!current || !incoming || incoming.pageOffset === 0) return page;
  const existing = current.views.find(
    (result) => result.view.id === incoming.view.id,
  );
  if (!existing || incoming.pageOffset !== existing.rows.length) return page;

  return {
    ...page,
    views: [
      {
        ...incoming,
        pageOffset: 0,
        rows: [...existing.rows, ...incoming.rows],
      },
    ],
  };
};

export const BaseViewer: FC<BaseViewerProps> = ({
  content,
  basePath,
  onFileOpen,
  onContentChange,
}) => {
  const projectId = useProjectId();
  const { openFile, selectNode } = useFilesStore();
  // Seed from the cross-tab cache so a remount (tab switch) paints the last
  // materialized table instantly instead of flashing the loading spinner.
  const [document, setDocument] = useState<CbaseDocument | null>(() =>
    getCachedDocument(projectId, basePath, content),
  );
  const documentRef = useRef(document);
  documentRef.current = document;
  const [parseError, setParseError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(
    () => document?.views[0]?.view.id ?? null,
  );
  const activeViewIdRef = useRef(activeViewId);
  activeViewIdRef.current = activeViewId;
  const [overlay, setOverlay] = useState<PropertyOverlay>({});
  // Set after a persist so the resulting content change does not re-query.
  const skipNextQuery = useRef(false);
  // Supersession counter: bumping it cancels any in-flight query's effects.
  const queryVersion = useRef(0);
  const queryControllerRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // While a cell editor is open, incoming refreshes are parked here and
  // applied when the editor closes, so rows never move mid-edit.
  const editingRef = useRef(false);
  const pendingDocRef = useRef<{
    document: CbaseDocument;
    append: boolean;
  } | null>(null);

  const applyDocument = useCallback(
    (doc: CbaseDocument, append = false) => {
      if (doc.parseError) {
        setParseError(doc.parseError);
        documentRef.current = null;
        setDocument(null);
        return;
      }
      const next = append ? mergeDocumentPage(documentRef.current, doc) : doc;
      setParseError(null);
      documentRef.current = next;
      setDocument(next);
      setCachedDocument(projectId, basePath, content, next);
      setOverlay((current) => settleOverlay(allDocumentRows(next), current));
      setActiveViewId((prev) => {
        const views = next.definition?.views ?? [];
        if (prev && views.some((view) => view.id === prev)) return prev;
        const returnedViewId = next.views[0]?.view.id;
        const fallback =
          views.find((view) => view.id === returnedViewId) ??
          views.find((view) => view.default) ??
          views[0];
        return fallback?.id ?? null;
      });
    },
    [projectId, basePath, content],
  );

  // Silent refreshes (file-change events) keep the current table on screen
  // instead of flashing the loading state.
  const runQuery = useCallback(
    (
      silent: boolean,
      viewId?: string,
      offset = 0,
      append = false,
      limit = CBASE_PAGE_SIZE,
    ) => {
      if (!projectId) return;
      queryControllerRef.current?.abort();
      const controller = new AbortController();
      queryControllerRef.current = controller;
      queryVersion.current += 1;
      const version = queryVersion.current;
      if (append) {
        setIsLoadingMore(true);
      } else if (!silent) {
        setIsLoading(true);
        setLoadError(null);
      }

      queryCbase(projectId, content, basePath, {
        viewId,
        offset,
        limit,
        signal: controller.signal,
      })
        .then((doc) => {
          if (version !== queryVersion.current) return;
          if (silent && editingRef.current) {
            pendingDocRef.current = { document: doc, append };
            return;
          }
          applyDocument(doc, append);
        })
        .catch((e) => {
          if (version !== queryVersion.current) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (!silent) setLoadError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (version !== queryVersion.current) return;
          if (queryControllerRef.current === controller) {
            queryControllerRef.current = null;
          }
          setIsLoading(false);
          setIsLoadingMore(false);
        });
    },
    [content, basePath, projectId, applyDocument],
  );

  // Fetch the materialized document whenever the source content changes. When
  // a cached document already matches this content (tab remount), revalidate
  // silently so the cached table stays on screen instead of flashing loading.
  useEffect(() => {
    if (!projectId) return;
    if (skipNextQuery.current) {
      skipNextQuery.current = false;
      return;
    }
    const hasFreshCache =
      getCachedDocument(projectId, basePath, content) !== null;
    const cachedViewId = documentRef.current?.views[0]?.view.id;
    runQuery(hasFreshCache, cachedViewId);
    return () => {
      queryVersion.current += 1;
      queryControllerRef.current?.abort();
      queryControllerRef.current = null;
    };
  }, [runQuery, projectId, basePath, content]);

  const definition = document?.definition ?? null;

  // Rows follow workspace events, narrowed to the common glob forms used by
  // the active dataset. Uncommon glob syntax deliberately falls back to
  // match-all so the table can never become stale from a false negative.
  const datasetPathFilter = useMemo(
    () => createDatasetPathFilter(definition?.dataset),
    [definition?.dataset],
  );
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      const currentResult = documentRef.current?.views[0];
      const limit = Math.max(
        CBASE_PAGE_SIZE,
        currentResult?.rows.length ?? CBASE_PAGE_SIZE,
      );
      runQuery(true, activeViewIdRef.current ?? undefined, 0, false, limit);
    }, CBASE_REFRESH_SETTLE_MS);
  }, [runQuery]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    [],
  );

  useRepoEvents(projectId ? { projectId } : undefined, {
    channels: ["files"],
    pathFilter: (path) =>
      basePath !== path && basePath !== `/${path}` && datasetPathFilter(path),
    onInvalidate: scheduleRefresh,
  });

  const handleEditingChange = useCallback(
    (editing: boolean) => {
      editingRef.current = editing;
      if (!editing && pendingDocRef.current) {
        const pending = pendingDocRef.current;
        pendingDocRef.current = null;
        applyDocument(pending.document, pending.append);
      }
      // applyDocument is stable.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [applyDocument],
  );

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

  const overlaidRows = useMemo(
    () => applyOverlay(viewResult?.rows ?? [], overlay),
    [viewResult, overlay],
  );

  const canPersist =
    !!document && !document.isQueryLanguage && !!projectId && !!basePath;
  const canEditRows = !!projectId;

  const persistDefinition = useCallback(
    (updated: CbaseDefinition) => {
      if (!document || document.isQueryLanguage) return;
      if (!projectId || !basePath) return;
      skipNextQuery.current = true;
      // Optimistically reflect the definition change in the editor.
      const optimistic = { ...document, definition: updated };
      documentRef.current = optimistic;
      setDocument(optimistic);
      persistCbase(
        projectId,
        basePath,
        updated,
        effectiveProperties,
        activeViewId ?? undefined,
      )
        .then((result) => {
          documentRef.current = result.document;
          setDocument(result.document);
          // Persist changes the file content, so cache under the new content
          // to keep the next remount's cache hit accurate.
          setCachedDocument(
            projectId,
            basePath,
            result.content,
            result.document,
          );
          onContentChange?.(result.content);
        })
        .catch((e) => {
          skipNextQuery.current = false;
          setLoadError(e instanceof Error ? e.message : String(e));
        });
    },
    [
      document,
      projectId,
      basePath,
      effectiveProperties,
      activeViewId,
      onContentChange,
    ],
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

  const handleCellEdit = useCallback(
    (filePath: string, frontmatterKey: string, value: unknown) => {
      if (!projectId) return;
      const key = overlayKey(filePath, frontmatterKey);
      setOverlay((current) => ({ ...current, [key]: value }));
      setCbaseProperty(projectId, filePath, frontmatterKey, value).catch(
        (e) => {
          setOverlay((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
          toast({
            title: "Failed to update property",
            description: e instanceof Error ? e.message : String(e),
            variant: "warning",
          });
        },
      );
    },
    [projectId],
  );

  const handleNewNote = useCallback(() => {
    if (!projectId || !definition || !activeView) return;
    const folder =
      definition.template?.folder ?? datasetFolder(definition.dataset);
    const existing = document
      ? allDocumentRows(document).map((row) => row.filePath)
      : [];
    const path = nextUntitledPath(folder, existing);
    const noteContent =
      definition.template?.body != null
        ? `${newNoteContent(activeView, effectiveProperties)}${definition.template.body}`
        : newNoteContent(activeView, effectiveProperties);
    writeProjectFile(projectId, path, noteContent)
      .then(() => handleRowClick(path))
      .catch((e) => {
        toast({
          title: "Failed to create note",
          description: e instanceof Error ? e.message : String(e),
          variant: "warning",
        });
      });
  }, [
    projectId,
    definition,
    activeView,
    document,
    effectiveProperties,
    handleRowClick,
  ]);

  const handleViewSelect = useCallback(
    (viewId: string) => {
      if (viewId === activeViewId) return;
      setActiveViewId(viewId);
      runQuery(false, viewId);
    },
    [activeViewId, runQuery],
  );

  const handleLoadMore = useCallback(() => {
    if (!viewResult?.hasMore || isLoadingMore || !activeView) return;
    runQuery(true, activeView.id, overlaidRows.length, true, CBASE_PAGE_SIZE);
  }, [viewResult, isLoadingMore, activeView, runQuery, overlaidRows.length]);

  if (parseError) {
    return (
      <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-2 p-8 text-sm font-workspace">
        <span className="font-medium text-custom-text-100">
          Invalid .cbase file
        </span>
        <span className="text-custom-text-300">{parseError}</span>
      </div>
    );
  }

  if (isLoading && !document) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center text-sm text-custom-text-300 font-workspace">
        Loading...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm font-workspace">
        <span className="font-medium text-custom-text-100">
          Failed to load .cbase
        </span>
        <span className="text-custom-text-300">{loadError}</span>
      </div>
    );
  }

  if (!definition || !activeView || !viewResult) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center text-sm text-custom-text-300 font-workspace">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-100 font-workspace">
      <div className="min-h-0 flex-1 overflow-hidden">
        <BaseTable
          activeViewId={activeView.id}
          canEditRows={canEditRows}
          canPersist={canPersist}
          definedFilters={definition.filters ?? []}
          onCellEdit={canEditRows ? handleCellEdit : undefined}
          onColumnsChange={canPersist ? handleColumnsChange : undefined}
          onColumnWidthsChange={
            canPersist ? handleColumnWidthsChange : undefined
          }
          onEditingChange={handleEditingChange}
          onLoadMore={handleLoadMore}
          onNewNote={canEditRows ? handleNewNote : undefined}
          onOpenFile={handleRowClick}
          onSortChange={canPersist ? handleSortChange : undefined}
          onViewFiltersChange={canPersist ? handleViewFiltersChange : undefined}
          onViewSelect={handleViewSelect}
          properties={effectiveProperties}
          rows={overlaidRows}
          hasMore={viewResult.hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={viewResult.totalCount}
          view={activeView}
          viewFilters={activeView.filters ?? []}
          views={definition.views}
        />
      </div>
    </div>
  );
};
