import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MessageSquare,
  Loader2,
} from "lucide-react";
import { cn } from "@chro/ui/utils";
import {
  searchProjectFiles,
  generateTaskTranscript,
  type ProjectSearchResult,
} from "@/lib/project-client";
import type { StoredTask } from "@/session/types";

export interface AtPopoverHandle {
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

interface AtPopoverProps {
  open: boolean;
  query: string;
  projectId: string | null;
  workspacePath: string | null;
  containerRef: string | null;
  tasks: StoredTask[];
  onSelect: (path: string, isFile: boolean, branch?: string | null) => void;
  onClose: () => void;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

type PopoverItem =
  | { kind: "file"; path: string; is_file: boolean }
  | { kind: "task"; task: StoredTask }
  | { kind: "category"; category: CategoryView };

type CategoryView = "files" | "sessions";

const DEBOUNCE_MS = 150;

export const AtPopover = forwardRef<AtPopoverHandle, AtPopoverProps>(
  (
    {
      open,
      query,
      projectId,
      workspacePath,
      containerRef,
      tasks,
      onSelect,
      onClose,
      activeIndex,
      onActiveIndexChange,
    },
    ref,
  ) => {
    const [fileResults, setFileResults] = useState<ProjectSearchResult[]>([]);
    const [debouncedQuery, setDebouncedQuery] = useState(query);
    const [generatingId, setGeneratingId] = useState<string | null>(null);
    const [view, setView] = useState<"categories" | CategoryView>("categories");
    const requestIdRef = useRef(0);
    const listRef = useRef<HTMLDivElement>(null);

    // Reset view when popover closes
    useEffect(() => {
      if (!open) {
        setView("categories");
      }
    }, [open]);

    // Debounce query
    useEffect(() => {
      const timer = setTimeout(() => {
        setDebouncedQuery(query);
      }, DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [query]);

    // Search files
    useEffect(() => {
      const id = ++requestIdRef.current;

      if (!projectId || !debouncedQuery) {
        setFileResults([]);
        onActiveIndexChange(0);
        return;
      }

      searchProjectFiles(projectId, debouncedQuery)
        .then((res) => {
          if (id !== requestIdRef.current) return;
          setFileResults(res);
          onActiveIndexChange(0);
        })
        .catch(() => {
          if (id !== requestIdRef.current) return;
          setFileResults([]);
          onActiveIndexChange(0);
        });
    }, [projectId, debouncedQuery, onActiveIndexChange]);

    // Build combined items list
    const items: PopoverItem[] = [];

    if (view === "categories" && !debouncedQuery) {
      // Top-level category menu
      items.push({ kind: "category", category: "files" });
      items.push({ kind: "category", category: "sessions" });
    } else if (view === "categories" && debouncedQuery) {
      // Flat search across all categories
      const q = debouncedQuery.toLowerCase();
      for (const t of tasks) {
        const matchesTitle = t.title?.toLowerCase().includes(q);
        const matchesId = t.id.toLowerCase().startsWith(q);
        if (matchesTitle || matchesId) {
          items.push({ kind: "task", task: t });
        }
      }
      for (const r of fileResults) {
        items.push({ kind: "file", path: r.path, is_file: r.is_file });
      }
    } else if (view === "sessions") {
      // Show tasks, optionally filtered
      const q = debouncedQuery?.toLowerCase();
      for (const t of tasks) {
        if (q) {
          const matchesTitle = t.title?.toLowerCase().includes(q);
          const matchesId = t.id.toLowerCase().startsWith(q);
          if (!matchesTitle && !matchesId) continue;
        }
        items.push({ kind: "task", task: t });
      }
    } else if (view === "files") {
      // Show file results
      for (const r of fileResults) {
        items.push({ kind: "file", path: r.path, is_file: r.is_file });
      }
    }

    // Scroll active item into view
    useEffect(() => {
      if (!listRef.current) return;
      const active = listRef.current.children[activeIndex] as
        | HTMLElement
        | undefined;
      active?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    const navigateToCategory = useCallback(
      (category: CategoryView) => {
        setView(category);
        onActiveIndexChange(0);
      },
      [onActiveIndexChange],
    );

    const navigateBack = useCallback(() => {
      setView("categories");
      onActiveIndexChange(0);
    }, [onActiveIndexChange]);

    const handleSelectItem = useCallback(
      async (item: PopoverItem) => {
        if (item.kind === "category") {
          navigateToCategory(item.category);
          return;
        }
        if (item.kind === "file") {
          onSelect(item.path, item.is_file);
        } else if (item.kind === "task") {
          if (!workspacePath) return;
          const task = item.task;
          setGeneratingId(task.id);
          try {
            const filePath = await generateTaskTranscript(
              task.id,
              workspacePath,
              containerRef,
            );
            onSelect(filePath, true, task.branch);
          } catch {
            // Silently close on error (transcript generation may fail for
            // incomplete runs).
            onClose();
          } finally {
            setGeneratingId(null);
          }
        }
      },
      [workspacePath, containerRef, onSelect, onClose, navigateToCategory],
    );

    const handleKeyDownInternal = useCallback(
      (e: React.KeyboardEvent): boolean => {
        if (items.length === 0) {
          if (e.key === "Escape") {
            if (view !== "categories") {
              navigateBack();
            } else {
              onClose();
            }
            return true;
          }
          return false;
        }
        switch (e.key) {
          case "ArrowDown":
            onActiveIndexChange(Math.min(activeIndex + 1, items.length - 1));
            return true;
          case "ArrowUp":
            onActiveIndexChange(Math.max(activeIndex - 1, 0));
            return true;
          case "Tab":
          case "Enter": {
            const selected = items[activeIndex];
            if (selected) void handleSelectItem(selected);
            return true;
          }
          case "Escape":
            if (view !== "categories") {
              navigateBack();
            } else {
              onClose();
            }
            return true;
          default:
            return false;
        }
      },
      [
        activeIndex,
        items,
        view,
        onActiveIndexChange,
        handleSelectItem,
        onClose,
        navigateBack,
      ],
    );

    useImperativeHandle(
      ref,
      () => ({
        handleKeyDown: handleKeyDownInternal,
      }),
      [handleKeyDownInternal],
    );

    if (!open) return null;

    const showBackButton = view !== "categories";

    return (
      <div
        className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        onMouseDown={(e) => e.preventDefault()}
      >
        <div ref={listRef} className="max-h-[320px] overflow-y-auto p-1">
          {showBackButton && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50"
              onMouseDown={(e) => {
                e.preventDefault();
                navigateBack();
              }}
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              <span className="font-medium">Back</span>
            </button>
          )}

          {items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {view === "files"
                ? debouncedQuery
                  ? "No results found"
                  : "Type to search files"
                : view === "sessions"
                  ? debouncedQuery
                    ? "No sessions found"
                    : "No sessions found"
                  : debouncedQuery
                    ? "No results found"
                    : "Type to search"}
            </div>
          ) : (
            items.map((item, index) => {
              if (item.kind === "category") {
                const isSessions = item.category === "sessions";
                return (
                  <button
                    key={item.category}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      index === activeIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      navigateToCategory(item.category);
                    }}
                    onMouseEnter={() => onActiveIndexChange(index)}
                  >
                    {isSessions ? (
                      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="font-medium">
                      {isSessions ? "Sessions" : "Files & Folders"}
                    </span>
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                );
              }

              if (item.kind === "task") {
                const t = item.task;
                const isGenerating = generatingId === t.id;
                const label = t.title || "Task";
                return (
                  <button
                    key={`task-${t.id}`}
                    type="button"
                    disabled={isGenerating}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      index === activeIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void handleSelectItem(item);
                    }}
                    onMouseEnter={() => onActiveIndexChange(index)}
                  >
                    {isGenerating ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-medium">{label}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {t.id.slice(0, 8)}
                    </span>
                  </button>
                );
              }

              // File item
              const fileName = item.path.split("/").pop() ?? item.path;
              const dirPath = item.path.slice(
                0,
                item.path.length - fileName.length,
              );
              return (
                <button
                  key={item.path}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    index === activeIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item.path, item.is_file);
                  }}
                  onMouseEnter={() => onActiveIndexChange(index)}
                >
                  {item.is_file ? (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">
                    {dirPath && (
                      <span className="text-muted-foreground">{dirPath}</span>
                    )}
                    <span className="font-medium">{fileName}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  },
);

AtPopover.displayName = "AtPopover";
