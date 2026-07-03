import { isImagePath } from "@/files/media-types";
import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { getTaskRunBinaryFileUrl } from "@/lib/project-client";
import { useTheme } from "@/settings/hooks/use-theme";
import { Button } from "@chro/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { generateDiffFile } from "@git-diff-view/file";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Folder,
  Image as ImageIcon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffChangeKind, DiffContent } from "../hooks";
import "@/styles/diff-style-overrides.css";

type DiffViewerPanelProps = {
  onClose: () => void;
  diffs: { path: string; diff: DiffContent }[];
  taskRunId?: string | null;
};

const LANGUAGE_MAP: Record<string, string> = {
  tsx: "typescript",
  ts: "typescript",
  jsx: "javascript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  css: "css",
  scss: "scss",
  html: "html",
  cpp: "cpp",
  c: "c",
  h: "c",
  sql: "sql",
  sh: "shell",
};

const getLanguageFromPath = (path?: string | null): string => {
  if (!path) return "plaintext";
  const extension = path.toLowerCase().split(".").pop();
  if (!extension) return "plaintext";
  return LANGUAGE_MAP[extension] ?? "plaintext";
};

// File tree types and builder
type TreeNode =
  | { key: string; name: string; type: "dir"; children: TreeNode[] }
  | {
      key: string;
      name: string;
      type: "file";
      diffId: string;
      change: DiffChangeKind;
      additions: number;
      deletions: number;
    };

function buildTree(
  items: { id: string; path: string; diff: DiffContent }[],
): TreeNode[] {
  const root: TreeNode & { type: "dir" } = {
    key: "",
    name: "",
    type: "dir",
    children: [],
  };

  for (const item of items) {
    const segments = item.path.split("/").filter(Boolean);
    if (segments.length === 0) segments.push(item.path || "unknown");

    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const isLast = i === segments.length - 1;
      const key = current.key ? `${current.key}/${segment}` : segment;

      if (isLast) {
        current.children.push({
          key,
          name: segment,
          type: "file",
          diffId: item.id,
          change: item.diff.change,
          additions: item.diff.additions ?? 0,
          deletions: item.diff.deletions ?? 0,
        });
      } else {
        let next = current.children.find(
          (c) => c.type === "dir" && c.name === segment,
        );
        if (!next) {
          next = { key, name: segment, type: "dir", children: [] };
          current.children.push(next);
        }
        if (next.type === "dir") current = next;
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "dir" ? -1 : 1;
    });
    for (const n of nodes) if (n.type === "dir") sortNodes(n.children);
  };
  sortNodes(root.children);
  return root.children;
}

function StatBadge({
  value,
  type,
}: {
  value: number;
  type: "add" | "del";
}) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "text-[11px] font-medium tabular-nums",
        type === "add"
          ? "text-emerald-500 dark:text-emerald-400"
          : "text-rose-500 dark:text-rose-400",
      )}
    >
      {type === "add" ? "+" : "-"}
      {value}
    </span>
  );
}

type FileTreeProps = {
  items: { id: string; path: string; diff: DiffContent }[];
  activeId: string | null;
  onSelect: (id: string) => void;
};

function FileTree({ items, activeId, onSelect }: FileTreeProps) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(items), [items]);

  useEffect(() => {
    setCollapsedDirs(new Set());
  }, [items]);

  const toggleDir = (key: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      if (node.type === "dir") {
        const isCollapsed = collapsedDirs.has(node.key);
        return (
          <li key={node.key}>
            <button
              type="button"
              onClick={() => toggleDir(node.key)}
              className={cn(
                "flex w-full items-center gap-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground",
                depth === 0 ? "px-2" : "pl-2 pr-2",
              )}
              style={{ paddingLeft: depth === 0 ? 8 : 8 + depth * 12 }}
            >
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              )}
              <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium text-foreground">
                {node.name}
              </span>
            </button>
            {!isCollapsed && node.children.length > 0 && (
              <ul>{renderNodes(node.children, depth + 1)}</ul>
            )}
          </li>
        );
      }

      const isActive = node.diffId === activeId;
      return (
        <li key={node.key}>
          <button
            type="button"
            onClick={() => onSelect(node.diffId)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
              isActive
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate flex-1">{node.name}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              <StatBadge value={node.additions} type="add" />
              <StatBadge value={node.deletions} type="del" />
            </span>
          </button>
        </li>
      );
    });

  if (tree.length === 0) return null;

  return (
    <nav
      className="w-64 shrink-0 overflow-y-auto border-l border-custom-border-200 pt-2 pb-4 pl-1"
      aria-label="Changed files"
    >
      <ul className="space-y-0.5">{renderNodes(tree, 0)}</ul>
    </nav>
  );
}

type DiffCardProps = {
  item: { id: string; path: string; diff: DiffContent };
  expanded: boolean;
  onToggle: () => void;
  viewMode: "unified" | "split";
  taskRunId?: string | null;
};

function ImageDiffPreview({
  path,
  change,
  taskRunId,
}: {
  path: string;
  change: DiffChangeKind;
  taskRunId: string;
}) {
  const imageUrl = `${getTaskRunBinaryFileUrl(taskRunId, path)}&_t=${Date.now()}`;
  const [error, setError] = useState(false);

  if (change === "deleted") {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-custom-text-300">
        Binary file deleted.
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center p-6 bg-custom-background-90">
      {error ? (
        <div className="text-xs text-custom-text-300">Failed to load image preview.</div>
      ) : (
        <img
          src={imageUrl}
          alt={path}
          className="max-h-[400px] max-w-full object-contain rounded border border-custom-border-200"
          onError={() => setError(true)}
          draggable={false}
        />
      )}
    </div>
  );
}

function DiffCard({ item, expanded, onToggle, viewMode, taskRunId }: DiffCardProps) {
  const path = item.path;
  const lang = getLanguageFromPath(path);
  const diff = item.diff;
  const { dataTheme: theme } = useTheme();
  const isImage = isImagePath(path);

  const oldContent = diff.old_content ?? "";
  const newContent = diff.new_content ?? "";
  const isContentEqual = oldContent === newContent;
  const isOmitted = diff.content_omitted ?? false;

  const diffFile = useMemo(() => {
    if (isImage || isContentEqual || isOmitted || (!oldContent && !newContent)) {
      return null;
    }
    try {
      const file = generateDiffFile(path, oldContent, path, newContent, lang, lang);
      file.initRaw();
      return file;
    } catch (e) {
      console.error("Failed to build diff", e);
      return null;
    }
  }, [isImage, isContentEqual, isOmitted, oldContent, newContent, path, lang]);

  const add = diffFile?.additionLength ?? diff.additions ?? 0;
  const del = diffFile?.deletionLength ?? diff.deletions ?? 0;
  const PathIcon = isImage ? ImageIcon : FileText;

  return (
    <div className="my-4 border border-custom-border-200 bg-custom-background-100">
      <div className="flex items-center px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggle}
          className="h-6 w-6 p-0 mr-2"
          title={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </Button>
        <p className="text-xs font-mono overflow-x-auto flex-1 text-custom-text-300">
          <PathIcon className="h-3 w-3 inline mr-2" aria-hidden />
          <span>{path}</span>
          {isImage ? (
            <span className="ml-3 text-custom-text-300">Binary</span>
          ) : (
            <>
              <span className="ml-3 text-emerald-600 dark:text-emerald-400">
                +{add}
              </span>
              <span className="ml-2 text-rose-600 dark:text-rose-400">-{del}</span>
            </>
          )}
        </p>
      </div>

      {expanded && isImage && taskRunId && (
        <div className="border-t border-custom-border-200">
          <ImageDiffPreview
            path={path}
            change={diff.change}
            taskRunId={taskRunId}
          />
        </div>
      )}

      {expanded && isImage && !taskRunId && (
        <div className="px-4 pb-4 text-xs font-mono border-t border-custom-border-200 pt-2 text-custom-text-300">
          Binary image file. Unable to preview.
        </div>
      )}

      {expanded && !isImage && diffFile && (
        <div className="border-t border-custom-border-200">
          <DiffView
            diffFile={diffFile}
            diffViewWrap={false}
            diffViewHighlight
            diffViewTheme={theme}
            diffViewMode={viewMode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewFontSize={12}
          />
        </div>
      )}

      {expanded && !isImage && !diffFile && (
        <div
          className="px-4 pb-4 text-xs font-mono border-t border-custom-border-200 pt-2 text-custom-text-300"
        >
          {diff.is_binary
            ? "Binary file changed."
            : isOmitted
              ? "Content omitted due to file size. Open in editor to view."
              : isContentEqual
                ? diff.change === "renamed"
                  ? "File renamed with no content changes."
                  : "No content changes to display."
                : "Failed to render diff for this file."}
        </div>
      )}
    </div>
  );
}

export function DiffViewerPanel({ onClose, diffs, taskRunId }: DiffViewerPanelProps) {
  const { t } = useLanguage();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const diffRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Create keyed items with stable IDs
  const keyedItems = useMemo(
    () =>
      diffs.map((d, index) => ({
        id: `${d.path}#${index}`,
        path: d.path,
        diff: d.diff,
      })),
    [diffs],
  );

  const diffIds = useMemo(() => keyedItems.map((item) => item.id), [keyedItems]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Set initial active ID and reset collapse state when diffs change
  useEffect(() => {
    setCollapsedIds(new Set());
    setActiveId((prev) => {
      if (prev && keyedItems.some((item) => item.id === prev)) return prev;
      return keyedItems[0]?.id ?? null;
    });
  }, [keyedItems]);

  // Default-collapse certain change kinds on first load
  useEffect(() => {
    if (keyedItems.length === 0) return;
    const kindsToCollapse = new Set(["deleted", "renamed", "copied", "permission_change"]);
    const initial = new Set(
      keyedItems
        .filter((item) => kindsToCollapse.has(item.diff.change))
        .map((item) => item.id),
    );
    if (initial.size > 0) setCollapsedIds(initial);
  }, [keyedItems]);

  const totalAdditions = diffs.reduce(
    (sum, d) => sum + (d.diff.additions ?? 0),
    0,
  );
  const totalDeletions = diffs.reduce(
    (sum, d) => sum + (d.diff.deletions ?? 0),
    0,
  );

  const toggle = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (expanded) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectFromTree = useCallback(
    (id: string) => {
      setActiveId(id);
      setExpanded(id, true);
      const ref = diffRefs.current[id];
      if (ref) {
        ref.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [setExpanded],
  );

  const handleToggle = useCallback(
    (id: string) => {
      setActiveId(id);
      toggle(id);
    },
    [toggle],
  );

  const allCollapsed = collapsedIds.size === keyedItems.length;
  const handleCollapseAll = useCallback(() => {
    setCollapsedIds(allCollapsed ? new Set() : new Set(diffIds));
  }, [allCollapsed, diffIds]);

  return (
    <div className="flex h-full flex-col bg-custom-background-100 text-custom-text-100">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-custom-border-200 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 text-xs text-custom-text-300">
            <span>
              {diffs.length} file{diffs.length !== 1 ? "s" : ""} changed
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              +{totalAdditions}
            </span>
            <span className="text-rose-600 dark:text-rose-400">
              -{totalDeletions}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={viewMode === "unified" ? "secondary" : "ghost"}
            className="h-7 px-2 text-xs"
            onClick={() => setViewMode("unified")}
            aria-pressed={viewMode === "unified"}
          >
            Unified
          </Button>
          <Button
            type="button"
            size="sm"
            variant={viewMode === "split" ? "secondary" : "ghost"}
            className="h-7 px-2 text-xs"
            onClick={() => setViewMode("split")}
            aria-pressed={viewMode === "split"}
          >
            Split
          </Button>
          <div className="w-px h-4 bg-custom-border-200 mx-1" />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={handleCollapseAll}
            aria-pressed={allCollapsed}
          >
            {allCollapsed ? "Expand All" : "Collapse All"}
          </Button>
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={onClose}
                  aria-label={t("closeDiffViewer")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {t("closeDiffViewer")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </header>

      {/* Content */}
      <div className="flex min-h-0 flex-1 overflow-hidden px-3 gap-4">
        {/* Scrollable diff cards */}
        <div className="flex-1 overflow-y-auto">
          {keyedItems.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground h-full">
              {t("diffViewerSelectFile")}
            </div>
          ) : (
            keyedItems.map((item) => (
              <div
                key={item.id}
                ref={(el) => {
                  if (el) diffRefs.current[item.id] = el;
                  else delete diffRefs.current[item.id];
                }}
              >
                <DiffCard
                  item={item}
                  expanded={!collapsedIds.has(item.id)}
                  onToggle={() => handleToggle(item.id)}
                  viewMode={viewMode}
                  taskRunId={taskRunId}
                />
              </div>
            ))
          )}
        </div>

        {/* File tree sidebar */}
        {keyedItems.length > 0 && (
          <FileTree
            items={keyedItems}
            activeId={activeId}
            onSelect={handleSelectFromTree}
          />
        )}
      </div>
    </div>
  );
}
