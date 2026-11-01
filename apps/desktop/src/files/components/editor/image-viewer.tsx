import { getProjectBinaryFileUrl } from "@/lib/project-client";
import { Button } from "@chro/ui/button";
import { RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useProjectId } from "../../context/project-context";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  type Point,
  type Size,
  anchoredScroll,
  clampZoom,
  fitScale,
  imageOffset,
  orientedSize,
  pinchFactor,
} from "../../lib/image-zoom";

const VIEWPORT_PADDING = 32;
const ZOOM_STEP = 1.25;

// WebKit (WKWebView/Safari) reports trackpad pinch as non-standard gesture
// events instead of ctrl+wheel.
interface WebKitGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

// Load results are tagged with their URL so a stale result never applies to a
// new image, and no reset effect can clobber a load that already fired.
type ImageLoad = { url: string; size: Size } | { url: string; error: string };

interface ImageViewerProps {
  relativePath: string;
  fileName: string;
  contentVersion?: number;
  sourceUrl?: string;
}

export const ImageViewer = ({
  relativePath,
  fileName,
  contentVersion,
  sourceUrl,
}: ImageViewerProps) => {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [load, setLoad] = useState<ImageLoad | null>(null);
  const [viewportSize, setViewportSize] = useState<Size | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const projectId = useProjectId();
  const imageUrl = useMemo(() => {
    if (sourceUrl) return sourceUrl;
    if (!projectId) return "";
    const base = getProjectBinaryFileUrl(projectId, relativePath);
    return contentVersion ? `${base}&_v=${contentVersion}` : base;
  }, [projectId, relativePath, contentVersion, sourceUrl]);

  const currentLoad = load?.url === imageUrl ? load : null;
  const naturalSize =
    currentLoad && "size" in currentLoad ? currentLoad.size : null;
  const error =
    currentLoad && "error" in currentLoad ? currentLoad.error : null;
  const loading = currentLoad === null;

  useEffect(() => {
    setZoom(1);
    setRotation(0);
  }, [imageUrl]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () =>
      setViewportSize({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // `zoom` is relative to the fitted size, so 100% always means "fit".
  const layout = useMemo(() => {
    if (!naturalSize || !viewportSize) return null;
    const oriented = orientedSize(naturalSize, rotation);
    const scale = fitScale(oriented, viewportSize, VIEWPORT_PADDING) * zoom;
    const box = {
      width: oriented.width * scale,
      height: oriented.height * scale,
    };
    return {
      box,
      image: {
        width: naturalSize.width * scale,
        height: naturalSize.height * scale,
      },
      content: {
        width: Math.max(viewportSize.width, box.width + VIEWPORT_PADDING * 2),
        height: Math.max(
          viewportSize.height,
          box.height + VIEWPORT_PADDING * 2,
        ),
      },
      offset: {
        x: imageOffset(viewportSize.width, box.width, VIEWPORT_PADDING),
        y: imageOffset(viewportSize.height, box.height, VIEWPORT_PADDING),
      },
    };
  }, [naturalSize, viewportSize, rotation, zoom]);

  // Gesture handlers are bound once; they read the latest render through refs.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const boxRef = useRef<Size | null>(null);
  boxRef.current = layout?.box ?? null;

  // Resizes synchronously, then scrolls so the image point under `anchor`
  // (viewport-relative) stays put.
  const zoomAround = (nextZoom: number, anchor: Point) => {
    const viewport = viewportRef.current;
    const from = boxRef.current;
    const clamped = clampZoom(nextZoom);
    if (!viewport || !from || clamped === zoomRef.current) return;
    const scroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
    flushSync(() => setZoom(clamped));
    const to = boxRef.current;
    if (!to) return;
    const next = anchoredScroll({
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
      padding: VIEWPORT_PADDING,
      scroll,
      anchor,
      from,
      to,
    });
    viewport.scrollLeft = next.left;
    viewport.scrollTop = next.top;
  };
  const zoomAroundRef = useRef(zoomAround);
  zoomAroundRef.current = zoomAround;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const anchorOf = (event: { clientX: number; clientY: number }) => {
      const rect = viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    let gestureBaseZoom: number | null = null;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureBaseZoom = zoomRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (gestureBaseZoom === null) return;
      const gesture = event as WebKitGestureEvent;
      zoomAroundRef.current(gestureBaseZoom * gesture.scale, anchorOf(gesture));
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureBaseZoom = null;
    };
    // Chromium and WebView2 report trackpad pinch as ctrl+wheel. Plain wheel
    // events fall through to native scrolling, which pans the image.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || gestureBaseZoom !== null) return;
      event.preventDefault();
      zoomAroundRef.current(
        zoomRef.current * pinchFactor(event.deltaY),
        anchorOf(event),
      );
    };

    viewport.addEventListener("gesturestart", onGestureStart);
    viewport.addEventListener("gesturechange", onGestureChange);
    viewport.addEventListener("gestureend", onGestureEnd);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      viewport.removeEventListener("gesturestart", onGestureStart);
      viewport.removeEventListener("gesturechange", onGestureChange);
      viewport.removeEventListener("gestureend", onGestureEnd);
      viewport.removeEventListener("wheel", onWheel);
    };
  }, []);

  const zoomAroundCenter = (nextZoom: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    zoomAround(nextZoom, {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    });
  };

  const handleZoomIn = () => {
    zoomAroundCenter(zoom * ZOOM_STEP);
  };

  const handleZoomOut = () => {
    zoomAroundCenter(zoom / ZOOM_STEP);
  };

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setLoad({
      url: imageUrl,
      size: { width: img.naturalWidth, height: img.naturalHeight },
    });
  };

  const handleImageError = () => {
    setLoad({ url: imageUrl, error: "Failed to load image" });
  };

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-90 font-workspace">
      <header className="flex h-14 items-center justify-between bg-custom-background-100/95 px-5 border-b border-custom-border-200">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-custom-text-100">
            {fileName}
          </span>
          {naturalSize && (
            <span className="text-xs text-muted-foreground">
              {naturalSize.width} × {naturalSize.height}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            onClick={handleZoomOut}
            disabled={zoom <= MIN_ZOOM}
          >
            <ZoomOut className="size-4" />
          </Button>
          <span className="min-w-[4rem] text-center text-xs text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            onClick={handleZoomIn}
            disabled={zoom >= MAX_ZOOM}
          >
            <ZoomIn className="size-4" />
          </Button>
          <div className="mx-2 h-4 w-px bg-custom-border-200" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Rotate"
            onClick={handleRotate}
          >
            <RotateCw className="size-4" />
          </Button>
        </div>
      </header>

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-auto overscroll-contain bg-custom-background-90"
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Loading image...
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive">
            {error}
          </div>
        )}
        <div
          className="relative"
          style={
            layout
              ? { width: layout.content.width, height: layout.content.height }
              : undefined
          }
        >
          <div
            className="absolute"
            style={
              layout
                ? {
                    left: layout.offset.x,
                    top: layout.offset.y,
                    width: layout.box.width,
                    height: layout.box.height,
                  }
                : undefined
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt={fileName}
              className="absolute top-1/2 left-1/2 max-w-none"
              style={{
                width: layout?.image.width,
                height: layout?.image.height,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                visibility: layout && !error ? "visible" : "hidden",
              }}
              onLoad={handleImageLoad}
              onError={handleImageError}
              draggable={false}
            />
          </div>
        </div>
      </div>

      <footer className="flex h-10 items-center gap-4 border-t border-custom-border-200 bg-custom-background-90 px-5 text-[12px] text-muted-foreground">
        <span>{relativePath}</span>
        {naturalSize && (
          <span>
            {naturalSize.width} × {naturalSize.height} px
          </span>
        )}
      </footer>
    </div>
  );
};
