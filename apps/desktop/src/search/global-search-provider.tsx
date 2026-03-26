import {
  type FileSearchResult,
  MATCH_TYPE_LABELS,
  enrichProjectResults,
} from "@/files/lib/file-search";
import { useLanguage } from "@/i18n";
import { searchProjectFiles } from "@/lib/project-client";
import { useProjectTasksStream } from "@/session/hooks/use-project-tasks-stream";
import { Dialog, Transition } from "@headlessui/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Disc, FileText, Folder, Loader2, Search, X } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type SearchResultItem,
  filterSessions,
  isCurrentRequest,
  mergeResults,
  nextSearchId,
} from "./global-search-logic";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type GlobalSearchContextValue = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

const GlobalSearchContext = createContext<GlobalSearchContextValue | null>(
  null,
);

export function useGlobalSearch() {
  const ctx = useContext(GlobalSearchContext);
  if (!ctx) {
    throw new Error(
      "useGlobalSearch must be used within a GlobalSearchProvider",
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);

  const open = useCallback(() => {
    setHasInitialized(true);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Global keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const isMeta = event.metaKey || event.ctrlKey;
      if (
        isMeta &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [open]);

  const value = useMemo<GlobalSearchContextValue>(
    () => ({ isOpen, open, close }),
    [isOpen, open, close],
  );

  return (
    <GlobalSearchContext.Provider value={value}>
      {children}
      {hasInitialized ? (
        <GlobalSearchModal isOpen={isOpen} onClose={close} />
      ) : null}
    </GlobalSearchContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 160;
const FILE_SEARCH_LIMIT = 20;

function GlobalSearchModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { projectId } = useParams({ strict: false }) as {
    projectId?: string;
  };

  const [query, setQuery] = useState("");
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const lastSearchId = useRef(0);

  const canSearch = Boolean(projectId);

  // Session data via WebSocket (only while modal is open)
  const { tasks } = useProjectTasksStream({
    projectId: projectId ?? null,
    enabled: isOpen && canSearch,
  });

  // Client-side session filtering
  const sessionResults = useMemo(
    () => filterSessions(tasks, query),
    [query, tasks],
  );

  // Debounced file search
  useEffect(() => {
    if (!isOpen || !canSearch || !projectId) return;

    const trimmed = query.trim();
    if (!trimmed) {
      // Invalidate any in-flight request so late responses are ignored
      nextSearchId(lastSearchId);
      setFileResults([]);
      setIsFileLoading(false);
      return;
    }

    setIsFileLoading(true);
    const requestId = nextSearchId(lastSearchId);

    const timer = setTimeout(async () => {
      try {
        const raw = await searchProjectFiles(projectId, trimmed, {
          limit: FILE_SEARCH_LIMIT,
        });
        if (!isCurrentRequest(lastSearchId, requestId)) return;
        setFileResults(enrichProjectResults(raw));
      } catch (error) {
        if (isCurrentRequest(lastSearchId, requestId)) {
          console.error("[global-search] File search failed", error);
          setFileResults([]);
        }
      } finally {
        if (isCurrentRequest(lastSearchId, requestId)) {
          setIsFileLoading(false);
        }
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [canSearch, isOpen, projectId, query]);

  // Combined flat list
  const allResults = useMemo(
    () => mergeResults(sessionResults, fileResults),
    [sessionResults, fileResults],
  );

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(allResults.length > 0 ? 0 : -1);
  }, [allResults.length]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && canSearch) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isOpen, canSearch]);

  // Reset state when closed
  const handleClose = useCallback(() => {
    onClose();
    setQuery("");
    setFileResults([]);
    setSelectedIndex(-1);
    setIsFileLoading(false);
    nextSearchId(lastSearchId);
  }, [onClose]);

  // Scroll active item into view
  useEffect(() => {
    if (!isOpen || selectedIndex < 0) return;
    const container = resultsRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLButtonElement>(
      `[data-search-index="${selectedIndex}"]`,
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [isOpen, selectedIndex, allResults.length]);

  // Navigate to result
  const handleSelectResult = useCallback(
    (item: SearchResultItem) => {
      if (!projectId) return;

      if (item.category === "session") {
        void navigate({
          to: "/projects/$projectId/session/$taskId",
          params: { projectId, taskId: item.task.id },
        });
      } else {
        void navigate({
          to: "/projects/$projectId/files",
          params: { projectId },
          search: { path: item.file.normalizedPath },
        });
      }
      handleClose();
    },
    [handleClose, navigate, projectId],
  );

  // Keyboard navigation
  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) =>
          allResults.length > 0
            ? prev < allResults.length - 1
              ? prev + 1
              : 0
            : -1,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) =>
          allResults.length > 0
            ? prev > 0
              ? prev - 1
              : allResults.length - 1
            : -1,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (selectedIndex >= 0 && allResults[selectedIndex]) {
          handleSelectResult(allResults[selectedIndex]);
        }
      }
    },
    [allResults, handleSelectResult, selectedIndex],
  );

  const showEmptyState = !query.trim();
  const showNoResults =
    Boolean(query.trim()) && !allResults.length && !isFileLoading;

  // Compute section boundaries for rendering headers
  const hasSessionResults = sessionResults.length > 0;
  const hasFileResults = fileResults.length > 0;
  let flatIndex = 0;

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[80]" onClose={handleClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-100"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-75"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-custom-backdrop/70" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-start justify-center px-4 pt-[15vh]">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-150"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-100"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-2xl transform overflow-hidden rounded-lg border border-custom-border-200 bg-custom-background-100 shadow-custom-shadow-lg transition-all">
                {/* Search Input */}
                <div className="flex items-center gap-2 border-b border-custom-border-200 px-4 py-3">
                  <Search className="size-4 flex-shrink-0 text-custom-text-300" />
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={handleInputKeyDown}
                    placeholder={
                      canSearch
                        ? t("globalSearchPlaceholder")
                        : t("globalSearchSelectProject")
                    }
                    disabled={!canSearch}
                    className="min-w-0 flex-1 bg-transparent text-sm text-custom-text-100 placeholder:text-custom-text-300 outline-none"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="flex h-5 w-10 items-center justify-end">
                    {isFileLoading && (
                      <Loader2 className="size-4 animate-spin text-custom-text-300" />
                    )}
                    {query && !isFileLoading && (
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        className="rounded p-0.5 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-200"
                        aria-label="Clear search"
                      >
                        <X className="size-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Results */}
                <div
                  ref={resultsRef}
                  className="h-[400px] overflow-y-auto px-2 py-2"
                >
                  {!canSearch && (
                    <p className="px-3 py-4 text-sm text-custom-text-300">
                      {t("globalSearchSelectProject")}
                    </p>
                  )}

                  {canSearch && showEmptyState && (
                    <div className="flex h-full items-center justify-center text-sm text-custom-text-300">
                      {t("globalSearchPlaceholder")}
                    </div>
                  )}

                  {canSearch && showNoResults && (
                    <div className="flex h-full items-center justify-center text-sm text-custom-text-300">
                      {t("globalSearchNoResults")}
                    </div>
                  )}

                  {canSearch && allResults.length > 0 && (
                    <div
                      role="listbox"
                      aria-label="Search results"
                      className="space-y-0.5"
                    >
                      {/* Sessions section */}
                      {hasSessionResults && (
                        <>
                          <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-custom-text-400">
                            {t("globalSearchSessions")}
                          </div>
                          {sessionResults.map((item) => {
                            const idx = flatIndex++;
                            const isActive = idx === selectedIndex;
                            return (
                              <button
                                key={item.task.id}
                                type="button"
                                data-search-index={idx}
                                onClick={() => handleSelectResult(item)}
                                onMouseEnter={() => setSelectedIndex(idx)}
                                className={`flex w-full items-center gap-3 rounded px-3 py-1.5 text-left text-sm ${
                                  isActive
                                    ? "bg-custom-background-80 text-custom-text-100"
                                    : "text-custom-text-200 hover:bg-custom-background-90"
                                }`}
                                role="option"
                                aria-selected={isActive}
                              >
                                <Disc className="size-4 flex-shrink-0 text-custom-text-300" />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium">
                                    {item.task.title || t("sessionUnresolved")}
                                  </div>
                                  {item.task.branch && (
                                    <div className="truncate text-xs text-custom-text-400">
                                      {item.task.branch}
                                    </div>
                                  )}
                                </div>
                                <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-custom-text-400">
                                  {item.task.status}
                                </span>
                              </button>
                            );
                          })}
                        </>
                      )}

                      {/* Files section */}
                      {hasFileResults && (
                        <>
                          <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-custom-text-400">
                            {t("globalSearchFiles")}
                          </div>
                          {fileResults.map((file, i) => {
                            const idx = flatIndex++;
                            const isActive = idx === selectedIndex;
                            return (
                              <button
                                key={`${file.path}-${i}`}
                                type="button"
                                data-search-index={idx}
                                onClick={() =>
                                  handleSelectResult({
                                    category: "file",
                                    file,
                                  })
                                }
                                onMouseEnter={() => setSelectedIndex(idx)}
                                className={`flex w-full items-center gap-3 rounded px-3 py-1.5 text-left text-sm ${
                                  isActive
                                    ? "bg-custom-background-80 text-custom-text-100"
                                    : "text-custom-text-200 hover:bg-custom-background-90"
                                }`}
                                role="option"
                                aria-selected={isActive}
                              >
                                {file.is_file ? (
                                  <FileText className="size-4 flex-shrink-0 text-custom-text-300" />
                                ) : (
                                  <Folder className="size-4 flex-shrink-0 text-custom-text-300" />
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium">
                                    {file.name}
                                  </div>
                                  <div className="truncate text-xs text-custom-text-400">
                                    {file.path}
                                  </div>
                                </div>
                                <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-custom-text-400">
                                  {MATCH_TYPE_LABELS[file.match_type]}
                                </span>
                              </button>
                            );
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
