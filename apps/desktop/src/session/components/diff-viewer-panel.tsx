import { isImagePath } from "@/files/media-types";
import { useFilesStore } from "@/files/state/files-store";
import { useLanguage } from "@/i18n";
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
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffChangeKind, DiffContent } from "../hooks";
import { useAnchorScroll } from "../hooks/use-anchor-scroll";
import {
  DIFF_EXPAND_BATCH_SIZE,
  MAX_RENDERED_DIFF_BYTES,
  bulkExpandedDiffIds,
  shouldBuildInlineDiff,
} from "../lib/diff-render-policy";
import { resolveDiffReveal } from "../lib/diff-reveal";
import "@/styles/diff-style-overrides.css";

const DIFF_ROW_OVERSCAN = 2;

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
        <div className="text-xs text-custom-text-300">
          Failed to load image preview.
        </div>
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

function DiffCard({
  item,
  expanded,
  onToggle,
  viewMode,
  taskRunId,
}: DiffCardProps) {
  const path = item.path;
  const lang = getLanguageFromPath(path);
  const diff = item.diff;
  const { dataTheme: theme } = useTheme();
  const isImage = isImagePath(path);

  const oldContent = diff.old_content ?? "";
  const newContent = diff.new_content ?? "";
  const isContentEqual = oldContent === newContent;
  const isOmitted = diff.content_omitted ?? false;
  const shouldBuild = shouldBuildInlineDiff({
    expanded,
    isImage,
    isContentEqual,
    isOmitted,
    oldContent,
    newContent,
  });
  const isTooLargeToRender =
    oldContent.length + newContent.length > MAX_RENDERED_DIFF_BYTES;

  const diffFile = useMemo(() => {
    if (!shouldBuild) {
      return null;
    }
    try {
      const file = generateDiffFile(
        path,
        oldContent,
        path,
        newContent,
        lang,
        lang,
      );
      file.initRaw();
      return file;
    } catch (e) {
      console.error("Failed to build diff", e);
      return null;
    }
  }, [shouldBuild, oldContent, newContent, path, lang]);

  const add = diffFile?.additionLength ?? diff.additions ?? 0;
  const del = diffFile?.deletionLength ?? diff.deletions ?? 0;
  const PathIcon = isImage ? ImageIcon : FileText;

  return (
    <div className="border border-custom-border-200 bg-custom-background-100">
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
              <span className="ml-2 text-rose-600 dark:text-rose-400">
                -{del}
              </span>
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
            diffViewMode={
              viewMode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified
            }
            diffViewFontSize={12}
          />
        </div>
      )}

      {expanded && !isImage && !diffFile && (
        <div className="px-4 pb-4 text-xs font-mono border-t border-custom-border-200 pt-2 text-custom-text-300">
          {diff.is_binary
            ? "Binary file changed."
            : isOmitted || isTooLargeToRender
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

export function DiffViewerPanel({
  onClose,
  diffs,
  taskRunId,
}: DiffViewerPanelProps) {
  const { t } = useLanguage();
  // Diff bodies are opt-in. Mounting every body on the first frame caused the
  // renderer to synchronously parse every changed file before the user could
  // interact with the tab.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
  const diffRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollToAnchor = useAnchorScroll(scrollRef);
  const diffReveal = useFilesStore((s) => s.diffReveal);

  // Create keyed items with stable IDs
  const keyedItems = useMemo(
    () =>
      diffs.map((d) => ({
        id: d.path,
        path: d.path,
        diff: d.diff,
      })),
    [diffs],
  );

  const diffIds = useMemo(
    () => keyedItems.map((item) => item.id),
    [keyedItems],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Drop expansion state only for files that disappeared. Incoming stream
  // patches must not reopen every diff card.
  useEffect(() => {
    const validIds = new Set(diffIds);
    setExpandedIds((previous) => {
      const next = new Set([...previous].filter((id) => validIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [diffIds]);

  const totalAdditions = diffs.reduce(
    (sum, d) => sum + (d.diff.additions ?? 0),
    0,
  );
  const totalDeletions = diffs.reduce(
    (sum, d) => sum + (d.diff.deletions ?? 0),
    0,
  );

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: keyedItems.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => keyedItems[index]?.id ?? index,
    estimateSize: (index) =>
      expandedIds.has(keyedItems[index]?.id ?? "") ? 640 : 58,
    overscan: DIFF_ROW_OVERSCAN,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [expandedIds, rowVirtualizer, viewMode]);

  // Scroll to the file the right dock asked for. The index of changed files
  // lives there, so the request arrives from outside this tab; handled-token
  // tracking keeps unrelated re-renders (a diff patch landing) from scrolling
  // again, while an unresolved request stays pending until its file streams in.
  const handledRevealTokenRef = useRef(0);
  useEffect(() => {
    const target = resolveDiffReveal({
      request: diffReveal,
      scopeTaskRunId: taskRunId ?? null,
      paths: keyedItems.map((item) => item.path),
      handledToken: handledRevealTokenRef.current,
    });
    if (!target) return;

    const index = keyedItems.findIndex(
      (candidate) => candidate.path === target.path,
    );
    const item = keyedItems[index];
    if (!item || index < 0) return;

    handledRevealTokenRef.current = target.token;
    setExpanded(item.id, true);
    // The target may not exist in the DOM yet because only visible rows are
    // mounted. Ask the virtualizer to mount it, then let the anchor helper keep
    // it aligned while the expanded diff finishes rendering and measuring.
    let raf = 0;
    const deadline = performance.now() + 2000;
    const reveal = () => {
      rowVirtualizer.scrollToIndex(index, { align: "start" });
      const element = diffRefs.current[item.id];
      if (element) {
        scrollToAnchor(element);
        return;
      }
      if (performance.now() < deadline) {
        raf = requestAnimationFrame(reveal);
      }
    };
    raf = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(raf);
  }, [
    diffReveal,
    keyedItems,
    rowVirtualizer,
    taskRunId,
    setExpanded,
    scrollToAnchor,
  ]);

  const allCollapsed = expandedIds.size === 0;
  const handleCollapseAll = useCallback(() => {
    setExpandedIds(allCollapsed ? bulkExpandedDiffIds(diffIds) : new Set());
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
            {allCollapsed
              ? keyedItems.length > DIFF_EXPAND_BATCH_SIZE
                ? `Expand First ${DIFF_EXPAND_BATCH_SIZE}`
                : "Expand All"
              : "Collapse All"}
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

      {/* Content: diff cards only. The index of changed files is the right
          dock's job; clicking a row there reveals the file here. */}
      <div className="flex min-h-0 flex-1 overflow-hidden px-3">
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {keyedItems.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground h-full">
              {t("diffViewerEmpty")}
            </div>
          ) : (
            <div
              className="relative w-full"
              style={{ height: rowVirtualizer.getTotalSize() }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                const item = keyedItems[virtualItem.index];
                if (!item) return null;
                return (
                  <div
                    key={item.id}
                    data-index={virtualItem.index}
                    ref={(element) => {
                      rowVirtualizer.measureElement(element);
                      if (element) diffRefs.current[item.id] = element;
                      else delete diffRefs.current[item.id];
                    }}
                    className="absolute left-0 top-0 w-full py-2"
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <DiffCard
                      item={item}
                      expanded={expandedIds.has(item.id)}
                      onToggle={() => toggle(item.id)}
                      viewMode={viewMode}
                      taskRunId={taskRunId}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
