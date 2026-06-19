import { useProjectId } from "@/files/context/project-context";
import { cn } from "@/lib/cn";
import {
  type WorkspaceMediaItem,
  getProjectBinaryFileUrl,
  getTaskRunBinaryFileUrl,
  listProjectMedia,
  listTaskRunMedia,
} from "@/lib/project-client";
import { useLayoutStore } from "@/workspace-layout/state/layout-store";
import { ImageOff, Images, Play, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

/** Matches the server-side default cap; the panel surfaces truncation. */
const MEDIA_LIMIT = 2000;

type LoadStatus = "loading" | "ready" | "error";

/**
 * Full-width grid of the renderable images/videos found on disk for the active
 * scope. With a `taskRunId` it shows a session's creatives (worktree-relative);
 * without one it shows the project's main checkout. Clicking a tile opens the
 * file in a normal editor tab, reusing the existing image/video viewers.
 */
export function GalleryPanel({ taskRunId }: { taskRunId?: string }) {
  const projectId = useProjectId();
  const openTab = useLayoutStore((s) => s.openTab);
  const [items, setItems] = useState<WorkspaceMediaItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<LoadStatus>("loading");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      let listing: Awaited<ReturnType<typeof listProjectMedia>>;
      if (taskRunId) {
        listing = await listTaskRunMedia(taskRunId, { limit: MEDIA_LIMIT });
      } else if (projectId) {
        listing = await listProjectMedia(projectId, { limit: MEDIA_LIMIT });
      } else {
        // No scope resolved yet (project context still loading).
        setItems([]);
        setTruncated(false);
        setStatus("ready");
        return;
      }
      setItems(listing.items);
      setTruncated(listing.truncated);
      setStatus("ready");
    } catch {
      setStatus("error");
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
      { activate: true },
    );
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden text-muted-foreground">
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-2 text-sm">
          <Images className="h-4 w-4 opacity-70" />
          <span className="font-medium">Gallery</span>
          {status === "ready" && items.length > 0 ? (
            <span className="text-xs opacity-60">
              {items.length}
              {truncated ? "+" : ""}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="Refresh gallery"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-muted hover:text-foreground"
        >
          <RefreshCw
            className={cn("h-4 w-4", status === "loading" && "animate-spin")}
          />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {status === "error" ? (
          <CenterMessage
            icon={<ImageOff className="h-6 w-6 opacity-50" />}
            text="Could not load media."
            action={
              <button
                type="button"
                onClick={() => void load()}
                className="rounded border border-border px-2 py-1 text-xs hover:bg-background"
              >
                Retry
              </button>
            }
          />
        ) : status === "ready" && items.length === 0 ? (
          <CenterMessage
            icon={<Images className="h-6 w-6 opacity-50" />}
            text="No images or videos yet."
          />
        ) : (
          <>
            {truncated ? (
              <p className="pb-3 pt-1 text-xs opacity-60">
                Showing the {MEDIA_LIMIT} most recent items. More exist on disk.
              </p>
            ) : null}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
              {items.map((item) => (
                <MediaTile
                  key={item.relativePath}
                  item={item}
                  src={thumbUrl(item)}
                  onOpen={() => openItem(item)}
                />
              ))}
            </div>
          </>
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
