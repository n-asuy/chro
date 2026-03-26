import { searchProjectFiles } from "@/lib/project-client";
import { Dialog, Transition } from "@headlessui/react";
import { FileText, Folder, Loader2, Search, X } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useProjectId } from "../context/project-context";
import {
  type FileSearchResult,
  MATCH_TYPE_LABELS,
  enrichProjectResults,
} from "../lib/file-search";
import { useFilesCommandPaletteStore } from "../state/files-command-palette-store";
import { useFileTreeStore } from "../state/file-tree-store";
import { useFilesStore } from "../state/files-store";

const QUICK_OPEN_LIMIT = 40;
const QUICK_OPEN_DEBOUNCE_MS = 160;

export const FilesCommandPalette = () => {
  const openFile = useFilesStore((state) => state.openFile);
  const selectNode = useFilesStore((state) => state.selectNode);
  const expandToPath = useFileTreeStore((state) => state.expandToPath);
  const isOpen = useFilesCommandPaletteStore((state) => state.isOpen);
  const openPaletteState = useFilesCommandPaletteStore((state) => state.open);
  const closePaletteState = useFilesCommandPaletteStore((state) => state.close);
  const projectId = useProjectId();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const lastSearchId = useRef(0);

  const canSearch = useMemo(() => Boolean(projectId), [projectId]);

  const focusInput = useCallback(() => {
    if (!canSearch) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [canSearch]);

  const openPalette = useCallback(() => {
    openPaletteState();
    focusInput();
  }, [focusInput, openPaletteState]);

  const closePalette = useCallback(() => {
    closePaletteState();
    setQuery("");
    setResults([]);
    setSelectedIndex(-1);
    setIsLoading(false);
  }, [closePaletteState]);

  const handleSelectResult = useCallback(
    (result: FileSearchResult) => {
      expandToPath(result.normalizedPath);
      selectNode(result.normalizedPath);
      if (result.is_file) {
        openFile(result.normalizedPath);
      }
      closePalette();
    },
    [closePalette, expandToPath, openFile, selectNode],
  );

  const performSearch = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || !projectId) {
        setResults([]);
        setSelectedIndex(-1);
        setIsLoading(false);
        return;
      }

      const requestId = ++lastSearchId.current;
      setIsLoading(true);
      try {
        const searchResults = await searchProjectFiles(projectId, trimmed, {
          limit: QUICK_OPEN_LIMIT,
        });
        if (requestId !== lastSearchId.current) {
          return;
        }
        const enriched = enrichProjectResults(searchResults);
        setResults(enriched);
        setSelectedIndex(enriched.length > 0 ? 0 : -1);
      } catch (error) {
        if (requestId === lastSearchId.current) {
          console.error("[files-command-palette] Search failed", error);
          setResults([]);
          setSelectedIndex(-1);
        }
      } finally {
        if (requestId === lastSearchId.current) {
          setIsLoading(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!isOpen || !canSearch) {
      return;
    }
    const timer = setTimeout(() => {
      void performSearch(query);
    }, QUICK_OPEN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [canSearch, isOpen, performSearch, query]);

  useEffect(() => {
    if (isOpen && canSearch) {
      focusInput();
    }
  }, [canSearch, focusInput, isOpen]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const isMeta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      // ⌘P, ⌘O (without shift) — ⌘K is reserved for global search
      const isPlainModifier = !event.altKey && !event.shiftKey;
      const isQuickOpen =
        isMeta && isPlainModifier && (key === "p" || key === "o");

      if (isQuickOpen) {
        event.preventDefault();
        if (!isOpen) {
          openPalette();
        } else {
          focusInput();
        }
        return;
      }

      if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        closePalette();
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [closePalette, focusInput, isOpen, openPalette]);

  useEffect(() => {
    if (!isOpen || selectedIndex < 0) {
      return;
    }
    const container = resultsRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLButtonElement>(
      `[data-command-index="${selectedIndex}"]`,
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [isOpen, selectedIndex, results.length]);

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // Skip if IME is composing (Japanese input etc.)
      if (event.nativeEvent.isComposing) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) =>
          results.length > 0 ? (prev < results.length - 1 ? prev + 1 : 0) : -1,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) =>
          results.length > 0 ? (prev > 0 ? prev - 1 : results.length - 1) : -1,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (selectedIndex >= 0 && results[selectedIndex]) {
          void handleSelectResult(results[selectedIndex]);
        }
      }
    },
    [handleSelectResult, results, selectedIndex],
  );

  const showEmptyState = !query.trim();
  const showNoResults = Boolean(query.trim()) && !results.length && !isLoading;

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-40" onClose={closePalette}>
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
                        ? "Jump to file…"
                        : "Select a workspace to search"
                    }
                    disabled={!canSearch}
                    className="min-w-0 flex-1 bg-transparent text-sm text-custom-text-100 placeholder:text-custom-text-300 outline-none"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="flex h-5 w-10 items-center justify-end">
                    {isLoading && (
                      <Loader2 className="size-4 animate-spin text-custom-text-300" />
                    )}
                    {query && !isLoading && (
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

                <div
                  ref={resultsRef}
                  className="h-[400px] overflow-y-auto px-2 py-2"
                >
                  {!canSearch && (
                    <p className="px-3 py-4 text-sm text-custom-text-300">
                      Choose a workspace to enable file search.
                    </p>
                  )}

                  {canSearch && showEmptyState && (
                    <div className="flex h-full items-center justify-center text-sm text-custom-text-300">
                      Start typing to search files.
                    </div>
                  )}

                  {canSearch && showNoResults && (
                    <div className="flex h-full items-center justify-center text-sm text-custom-text-300">
                      No files found for "{query.trim()}".
                    </div>
                  )}

                  {canSearch && results.length > 0 && (
                    <div
                      role="listbox"
                      aria-label="File search results"
                      className="space-y-0.5"
                    >
                      {results.map((result, index) => {
                        const isActive = index === selectedIndex;
                        return (
                          <button
                            key={`${result.path}-${index}`}
                            type="button"
                            data-command-index={index}
                            onClick={() => {
                              void handleSelectResult(result);
                            }}
                            onMouseEnter={() => setSelectedIndex(index)}
                            className={`flex w-full items-center gap-3 rounded px-3 py-1.5 text-left text-sm ${
                              isActive
                                ? "bg-custom-background-80 text-custom-text-100"
                                : "text-custom-text-200 hover:bg-custom-background-90"
                            }`}
                            role="option"
                            aria-selected={isActive}
                          >
                            {result.is_file ? (
                              <FileText className="size-4 flex-shrink-0 text-custom-text-300" />
                            ) : (
                              <Folder className="size-4 flex-shrink-0 text-custom-text-300" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">
                                {result.name}
                              </div>
                              <div className="truncate text-xs text-custom-text-400">
                                {result.path}
                              </div>
                            </div>
                            <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-custom-text-400">
                              {MATCH_TYPE_LABELS[result.match_type]}
                            </span>
                          </button>
                        );
                      })}
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
};
