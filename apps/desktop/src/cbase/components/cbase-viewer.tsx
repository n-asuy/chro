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
import { useRepoEvents } from "@/hooks/use-repo-events";
import { writeProjectFile } from "@/lib/project-client";
import { useProjectId } from "../../files/context/project-context";
import { useFilesStore } from "../../files/state/files-store";
import {
  getCachedDocument,
  setCachedDocument,
} from "../cbase-document-cache";
import { persistCbase, queryCbase, setCbaseProperty } from "../cbase-client";
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

const allDocumentRows = (doc: CbaseDocument): CbaseRow[] =>
  doc.views.flatMap((result) => result.rows);

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
  const [parseError, setParseError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<PropertyOverlay>({});
  // Set after a persist so the resulting content change does not re-query.
  const skipNextQuery = useRef(false);
  // Supersession counter: bumping it cancels any in-flight query's effects.
  const queryVersion = useRef(0);
  // While a cell editor is open, incoming refreshes are parked here and
  // applied when the editor closes, so rows never move mid-edit.
  const editingRef = useRef(false);
  const pendingDocRef = useRef<CbaseDocument | null>(null);

  const applyDocument = useCallback(
    (doc: CbaseDocument) => {
      if (doc.parseError) {
        setParseError(doc.parseError);
        setDocument(null);
        return;
      }
      setParseError(null);
      setDocument(doc);
      setCachedDocument(projectId, basePath, content, doc);
      setOverlay((current) => settleOverlay(allDocumentRows(doc), current));
      setActiveViewId((prev) => {
        const views = doc.definition?.views ?? [];
        if (prev && views.some((view) => view.id === prev)) return prev;
        const fallback = views.find((view) => view.default) ?? views[0];
        return fallback?.id ?? null;
      });
    },
    [projectId, basePath, content],
  );

  // Silent refreshes (file-change events) keep the current table on screen
  // instead of flashing the loading state.
  const runQuery = useCallback(
    (silent: boolean) => {
      if (!projectId) return;
      queryVersion.current += 1;
      const version = queryVersion.current;
      if (!silent) {
        setIsLoading(true);
        setLoadError(null);
      }

      queryCbase(projectId, content, basePath)
        .then((doc) => {
          if (version !== queryVersion.current) return;
          if (silent && editingRef.current) {
            pendingDocRef.current = doc;
            return;
          }
          applyDocument(doc);
        })
        .catch((e) => {
          if (version !== queryVersion.current) return;
          if (!silent)
            setLoadError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (version === queryVersion.current) setIsLoading(false);
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
    runQuery(hasFreshCache);
    return () => {
      queryVersion.current += 1;
    };
  }, [runQuery, projectId, basePath, content]);

  const definition = document?.definition ?? null;

  // Rows are workspace files, so the view follows worktree file events. The
  // filter stays loose (a false positive only costs a no-op re-query): all
  // `.md` files for the default markdown datasets; anything but the `.cbase`
  // itself when the dataset includes other file kinds. Changes to this file
  // arrive through the editor's `content` prop, not through events.
  const datasetIncludesOnlyMarkdown = (
    definition?.dataset.include ?? ["**/*.md"]
  ).every((glob) => glob.endsWith(".md"));
  useRepoEvents(projectId ? { projectId } : undefined, {
    channels: ["files"],
    pathFilter: (path) =>
      datasetIncludesOnlyMarkdown
        ? path.endsWith(".md")
        : basePath !== path && basePath !== `/${path}`,
    onInvalidate: () => runQuery(true),
  });

  const handleEditingChange = useCallback((editing: boolean) => {
    editingRef.current = editing;
    if (!editing && pendingDocRef.current) {
      const pending = pendingDocRef.current;
      pendingDocRef.current = null;
      applyDocument(pending);
    }
    // applyDocument is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyDocument]);

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
      setDocument({ ...document, definition: updated });
      persistCbase(projectId, basePath, updated, effectiveProperties)
        .then((result) => {
          setDocument(result.document);
          // Persist changes the file content, so cache under the new content
          // to keep the next remount's cache hit accurate.
          setCachedDocument(projectId, basePath, result.content, result.document);
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
    const folder = definition.template?.folder ?? datasetFolder(definition.dataset);
    const existing = document ? allDocumentRows(document).map((row) => row.filePath) : [];
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
          onColumnWidthsChange={canPersist ? handleColumnWidthsChange : undefined}
          onEditingChange={handleEditingChange}
          onNewNote={canEditRows ? handleNewNote : undefined}
          onOpenFile={handleRowClick}
          onSortChange={canPersist ? handleSortChange : undefined}
          onViewFiltersChange={canPersist ? handleViewFiltersChange : undefined}
          onViewSelect={setActiveViewId}
          properties={effectiveProperties}
          rows={overlaidRows}
          totalCount={viewResult.totalCount}
          view={activeView}
          viewFilters={activeView.filters ?? []}
          views={definition.views}
        />
      </div>
    </div>
  );
};
