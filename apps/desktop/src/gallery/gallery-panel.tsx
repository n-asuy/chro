import { useProjectId } from "@/files/context/project-context";
import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  type WorkspaceMediaItem,
  getProjectBinaryFileUrl,
  getTaskRunBinaryFileUrl,
  listProjectMedia,
  listTaskRunMedia,
} from "@/lib/project-client";
import { useLayoutStore } from "@/workspace-layout/state/layout-store";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ImageOff, Images, Play, RefreshCw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** Matches the server-side default cap; the panel surfaces truncation. */
const MEDIA_LIMIT = 2000;

/** Tile sizing. Columns are derived from the measured width, so the grid
 *  adapts to any pane width (narrow splits to full-width tabs). */
const MIN_TILE_PX = 160;
const GRID_GAP = 12;

type LoadStatus = "loading" | "ready" | "error";

/**
 * Grid of the renderable images/videos found on disk for the active scope. With
 * a `taskRunId` it shows a session's creatives (worktree-relative); without one
 * it shows the project's main checkout. Clicking a tile opens the file in a
 * normal editor tab, reusing the existing image/video viewers — the grid is a
 * visual index of the scope, not a viewer of its own.
 *
 * Rendered as the body of the gallery tab (project- or run-scoped), so it
 * carries no title of its own: the tab already names it.
 */
export function GalleryPanel({ taskRunId }: { taskRunId?: string }) {
  const projectId = useProjectId();
  const { t } = useLanguage();
  const openTab = useLayoutStore((s) => s.openTab);
  const [items, setItems] = useState<WorkspaceMediaItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<LoadStatus>("loading");
  // Generation guard: switching scope while a request is in flight must not let
  // the slower, older response paint over the newer scope's media.
  const loadEpochRef = useRef(0);

  const load = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    const isCurrent = () => epoch === loadEpochRef.current;
    setStatus("loading");
    // Drop the previous scope's tiles immediately so the grid never shows
    // another run's media while the new listing loads.
    setItems([]);
    setTruncated(false);
    try {
      let listing: Awaited<ReturnType<typeof listProjectMedia>>;
      if (taskRunId) {
        listing = await listTaskRunMedia(taskRunId, { limit: MEDIA_LIMIT });
      } else if (projectId) {
        listing = await listProjectMedia(projectId, { limit: MEDIA_LIMIT });
      } else {
        // No scope resolved yet (project context still loading).
        if (isCurrent()) setStatus("ready");
        return;
      }
      if (!isCurrent()) return;
      setItems(listing.items);
      setTruncated(listing.truncated);
      setStatus("ready");
    } catch {
      if (isCurrent()) setStatus("error");
    }
  }, [projectId, taskRunId]);

  useEffect(() => {
    void load();
  }, [load]);

  const thumbUrl = (item: WorkspaceMediaItem): string => {
    if (taskRunId) return getTaskRunBinaryFileUrl(taskRunId, item.relativePath);
    // `projectId` is always set when project-scoped items were loaded; the
    // empty fallback only guards the type and is never rendered.
    return projectId
      ? getProjectBinaryFileUrl(projectId, item.relativePath)
      : "";
  };

  const openItem = (item: WorkspaceMediaItem): void => {
    openTab(
      { type: "file", path: item.relativePath, taskRunId },
      { activate: true, returnFocusOnClose: true },
    );
  };

  // Track the scroller's inner width so the column count (and therefore the
  // virtualized row height) follows dock resizes and tab/dock placement.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // contentRect excludes the scroller's own padding, which is the width the
    // grid actually gets. ResizeObserver fires once on observe, so no separate
    // initial measurement is needed.
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setViewportWidth((prev) => (prev === width ? prev : width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { columns, rowHeight } = useMemo(() => {
    if (viewportWidth <= 0) return { columns: 1, rowHeight: MIN_TILE_PX };
    const fit = Math.floor(
      (viewportWidth + GRID_GAP) / (MIN_TILE_PX + GRID_GAP),
    );
    const cols = Math.max(1, fit);
    const tile = (viewportWidth - GRID_GAP * (cols - 1)) / cols;
    // Tiles are square, so the row's height is the tile width plus the gap that
    // separates it from the next row.
    return { columns: cols, rowHeight: tile + GRID_GAP };
  }, [viewportWidth]);

  const rowCount = Math.ceil(items.length / columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 2,
  });

  // Row heights are cached, so a width change (dock resize, tab vs dock) has to
  // invalidate them explicitly.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, rowHeight, columns]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden text-muted-foreground">
      {/* No title: the dock toolbar and the tab bar already name this surface.
          Only the count (context) and refresh (action) live here. */}
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-2 text-sm">
          {status === "ready" && items.length > 0 ? (
            <>
              <Images className="h-4 w-4 opacity-60" />
              <span className="text-xs opacity-60">
                {items.length}
                {truncated ? "+" : ""}
              </span>
            </>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          aria-label={t("galleryRefresh")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-muted hover:text-foreground"
        >
          <RefreshCw
            className={cn("h-4 w-4", status === "loading" && "animate-spin")}
          />
        </button>
      </div>

      {/* Kept out of the scroll area so the virtualizer's offsets stay pure
          (and the caveat stays visible while scrolling). */}
      {status === "ready" && truncated ? (
        <p className="shrink-0 px-4 pb-2 text-xs opacity-60">
          {t("galleryTruncated", { limit: MEDIA_LIMIT })}
        </p>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {status === "error" ? (
          <CenterMessage
            icon={<ImageOff className="h-6 w-6 opacity-50" />}
            text={t("galleryLoadError")}
            action={
              <button
                type="button"
                onClick={() => void load()}
                className="rounded border border-border px-2 py-1 text-xs hover:bg-background"
              >
                {t("galleryRetry")}
              </button>
            }
          />
        ) : status === "ready" && items.length === 0 ? (
          <CenterMessage
            icon={<Images className="h-6 w-6 opacity-50" />}
            text={t("galleryEmpty")}
          />
        ) : (
          // Windowed rows: only the visible slice mounts, so a 2000-item run
          // does not hold 2000 decoders / range requests open at once. Columns
          // follow the measured width, so this works in the narrow dock and in
          // a full-width tab alike.
          <div
            className="relative w-full"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {rowVirtualizer.getVirtualItems().map((row) => {
              const start = row.index * columns;
              const rowItems = items.slice(start, start + columns);
              return (
                <div
                  key={row.key}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    // Shorter than the row's slot by one gap; that difference is
                    // the visual gutter between rows.
                    height: Math.max(0, row.size - GRID_GAP),
                    transform: `translateY(${row.start}px)`,
                    display: "grid",
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    gap: `${GRID_GAP}px`,
                  }}
                >
                  {rowItems.map((item) => (
                    <MediaTile
                      key={item.relativePath}
                      item={item}
                      src={thumbUrl(item)}
                      onOpen={() => openItem(item)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaTile({
  item,
  src,
  onOpen,
}: {
  item: WorkspaceMediaItem;
  src: string;
  onOpen: () => void;
}) {
  const name = item.relativePath.split("/").pop() ?? item.relativePath;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={item.relativePath}
      className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-background/40 transition hover:border-foreground/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {item.kind === "video" ? (
        <>
          <video
            src={src}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white">
              <Play className="h-4 w-4 translate-x-px" />
            </span>
          </span>
        </>
      ) : (
        <img
          src={src}
          alt={name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2 py-1 text-left text-[11px] text-white opacity-0 transition group-hover:opacity-100">
        {name}
      </span>
    </button>
  );
}

function CenterMessage({
  icon,
  text,
  action,
}: {
  icon: ReactNode;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
      {icon}
      <span>{text}</span>
      {action}
    </div>
  );
}
