import {
  type ProjectSearchResult,
  listProjectEntries,
  searchProjectFiles,
} from "@/lib/project-client";
import {
  type SkillSummary,
  listSkills,
  skillSourceLabel,
} from "@/lib/skill-client";
import type { StoredTask } from "@/session/types";
import { cn } from "@chro/ui/utils";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MessageSquare,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

const DEFAULT_FILE_SUGGESTIONS = 5;

export type AtPopoverSelection =
  | { kind: "file"; path: string; isFile: boolean; branch?: string | null }
  | { kind: "session"; taskId: string; branch?: string | null }
  | { kind: "skill"; id: string; name: string };

export interface AtPopoverHandle {
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Open the popover directly into a category sub-view (used by the "+" menu). */
  openCategory: (category: CategoryView) => void;
}

interface AtPopoverProps {
  open: boolean;
  query: string;
  projectId: string | null;
  workspacePath: string | null;
  tasks: StoredTask[];
  onSelect: (selection: AtPopoverSelection) => void;
  onClose: () => void;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}

type PopoverItem =
  | { kind: "file"; path: string; is_file: boolean }
  | { kind: "task"; task: StoredTask }
  | { kind: "skill"; skill: SkillSummary }
  | { kind: "category"; category: CategoryView };

type CategoryView = "skills" | "files" | "sessions";

const CATEGORY_META: Record<
  CategoryView,
  { label: string; icon: typeof FolderOpen }
> = {
  skills: { label: "Skills", icon: BookOpen },
  files: { label: "Files & Folders", icon: FolderOpen },
  sessions: { label: "Sessions", icon: MessageSquare },
};

const DEBOUNCE_MS = 150;

export const AtPopover = forwardRef<AtPopoverHandle, AtPopoverProps>(
  (
    {
      open,
      query,
      projectId,
      workspacePath,
      tasks,
      onSelect,
      onClose,
      activeIndex,
      onActiveIndexChange,
    },
    ref,
  ) => {
    const [fileResults, setFileResults] = useState<ProjectSearchResult[]>([]);
    const [defaultFiles, setDefaultFiles] = useState<ProjectSearchResult[]>([]);
    const [skills, setSkills] = useState<SkillSummary[]>([]);
    const [debouncedQuery, setDebouncedQuery] = useState(query);
    const [view, setView] = useState<"categories" | CategoryView>("categories");
    const requestIdRef = useRef(0);
    const defaultRequestIdRef = useRef(0);
    const skillRequestIdRef = useRef(0);
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

    // Load default file suggestions when popover opens with no query
    useEffect(() => {
      if (!open || !projectId) return;
      const id = ++defaultRequestIdRef.current;
      listProjectEntries(projectId, { detail: "basic" })
        .then((entries) => {
          if (id !== defaultRequestIdRef.current) return;
          const files = entries
            .filter((e) => e.type === "file")
            .slice(0, DEFAULT_FILE_SUGGESTIONS)
            .map<ProjectSearchResult>((e) => ({
              path: e.relativePath,
              is_file: true,
              match_type: "FileName",
            }));
          setDefaultFiles(files);
        })
        .catch(() => {
          if (id !== defaultRequestIdRef.current) return;
          setDefaultFiles([]);
        });
    }, [open, projectId]);

    // Load skills when the popover opens
    useEffect(() => {
      if (!open) return;
      const id = ++skillRequestIdRef.current;
      listSkills(workspacePath)
        .then((res) => {
          if (id !== skillRequestIdRef.current) return;
          setSkills(res);
        })
        .catch(() => {
          if (id !== skillRequestIdRef.current) return;
          setSkills([]);
        });
    }, [open, workspacePath]);

    // Build combined items list
    const items: PopoverItem[] = [];

    if (view === "categories" && !debouncedQuery) {
      // Top-level category menu
      items.push({ kind: "category", category: "skills" });
      items.push({ kind: "category", category: "files" });
      items.push({ kind: "category", category: "sessions" });
    } else if (view === "categories" && debouncedQuery) {
      // Flat search across all categories
      const q = debouncedQuery.toLowerCase();
      for (const s of skills) {
        if (
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)
        ) {
          items.push({ kind: "skill", skill: s });
        }
      }
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
    } else if (view === "skills") {
      // Show skills, optionally filtered
      const q = debouncedQuery?.toLowerCase();
      for (const s of skills) {
        if (q) {
          const matches =
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.source_path.toLowerCase().includes(q);
          if (!matches) continue;
        }
        items.push({ kind: "skill", skill: s });
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
      // Show search results, or default suggestions if no query yet
      const source = debouncedQuery ? fileResults : defaultFiles;
      for (const r of source) {
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
      (item: PopoverItem) => {
        if (item.kind === "category") {
          navigateToCategory(item.category);
          return;
        }
        if (item.kind === "file") {
          onSelect({ kind: "file", path: item.path, isFile: item.is_file });
        } else if (item.kind === "task") {
          onSelect({
            kind: "session",
            taskId: item.task.id,
            branch: item.task.branch,
          });
        } else if (item.kind === "skill") {
          onSelect({ kind: "skill", id: item.skill.id, name: item.skill.name });
        }
      },
      [onSelect, navigateToCategory],
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
            if (selected) handleSelectItem(selected);
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
        openCategory: navigateToCategory,
      }),
      [handleKeyDownInternal, navigateToCategory],
    );

    if (!open) return null;

    const showBackButton = view !== "categories";

    return (
      <div
        className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-lg border border-border/60 bg-popover shadow-custom-shadow-sm"
        onMouseDown={(e) => e.preventDefault()}
      >
        <div ref={listRef} className="max-h-[320px] overflow-y-auto p-1">
          {showBackButton && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded px-2 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/40"
              onMouseDown={(e) => {
                e.preventDefault();
                navigateBack();
              }}
            >
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
              <span>Back</span>
            </button>
          )}

          {items.length === 0 ? (
            <div className="px-2 py-1.5 text-[13px] text-muted-foreground">
              {view === "files"
                ? debouncedQuery
                  ? "No results found"
                  : "Type to search files"
                : view === "sessions"
                  ? "No sessions found"
                  : view === "skills"
                    ? debouncedQuery
                      ? "No matching skills"
                      : "No skills found"
                    : debouncedQuery
                      ? "No results found"
                      : "Type to search"}
            </div>
          ) : (
            items.map((item, index) => {
              if (item.kind === "category") {
                const { label, icon: Icon } = CATEGORY_META[item.category];
                return (
                  <button
                    key={item.category}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded px-2 py-1 text-left text-[13px] transition-colors",
                      index === activeIndex
                        ? "bg-accent/60 text-accent-foreground"
                        : "hover:bg-accent/30",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      navigateToCategory(item.category);
                    }}
                    onMouseEnter={() => onActiveIndexChange(index)}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>{label}</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                );
              }

              if (item.kind === "skill") {
                const s = item.skill;
                return (
                  <button
                    key={`skill-${s.id}`}
                    type="button"
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded px-2 py-1 text-left text-[13px] transition-colors",
                      index === activeIndex
                        ? "bg-accent/60 text-accent-foreground"
                        : "hover:bg-accent/30",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect({ kind: "skill", id: s.id, name: s.name });
                    }}
                    onMouseEnter={() => onActiveIndexChange(index)}
                  >
                    <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{s.name}</span>
                      {s.description ? (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {s.description}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-[3px] shrink-0 text-[10px] text-muted-foreground">
                      {skillSourceLabel(s)}
                    </span>
                  </button>
                );
              }

              if (item.kind === "task") {
                const t = item.task;
                const label = t.title || "Task";
                return (
                  <button
                    key={`task-${t.id}`}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded px-2 py-1 text-left text-[13px] transition-colors",
                      index === activeIndex
                        ? "bg-accent/60 text-accent-foreground"
                        : "hover:bg-accent/30",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelectItem(item);
                    }}
                    onMouseEnter={() => onActiveIndexChange(index)}
                  >
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{label}</span>
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
                    "flex w-full items-center gap-2.5 rounded px-2 py-1 text-left text-[13px] transition-colors",
                    index === activeIndex
                      ? "bg-accent/60 text-accent-foreground"
                      : "hover:bg-accent/30",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect({
                      kind: "file",
                      path: item.path,
                      isFile: item.is_file,
                    });
                  }}
                  onMouseEnter={() => onActiveIndexChange(index)}
                >
                  {item.is_file ? (
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">
                    {dirPath && (
                      <span className="text-muted-foreground">{dirPath}</span>
                    )}
                    <span>{fileName}</span>
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
