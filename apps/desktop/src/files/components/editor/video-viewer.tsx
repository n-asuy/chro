
import { useEffect, useMemo, useState, useRef } from "react";
import { ZoomIn, ZoomOut, RotateCw } from "lucide-react";
import { Button } from "@chro/ui/button";
import { getProjectBinaryFileUrl } from "@/lib/project-client";
import { useProjectId } from "../../context/project-context";

interface VideoViewerProps {
  relativePath: string;
  fileName: string;
  contentVersion?: number;
}

export const VideoViewer = ({ relativePath, fileName, contentVersion }: VideoViewerProps) => {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const projectId = useProjectId();
  const videoUrl = useMemo(() => {
    if (!projectId) return "";
    const base = getProjectBinaryFileUrl(projectId, relativePath);
    return contentVersion ? `${base}&_v=${contentVersion}` : base;
  }, [projectId, relativePath, contentVersion]);

  useEffect(() => {
    setScale(1);
    setRotation(0);
    setNaturalSize(null);
    setLoading(true);
    setError(null);
  }, [relativePath]);

  const handleZoomIn = () => {
    setScale((prev) => Math.min(prev + 0.25, 5));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(prev - 0.25, 0.25));
  };

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleVideoLoadedMetadata = () => {
    const video = videoRef.current;
    if (video) {
      setNaturalSize({ width: video.videoWidth, height: video.videoHeight });
    }
    setLoading(false);
  };

  const handleVideoError = () => {
    setLoading(false);
    setError("Failed to load video");
  };

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-90 font-workspace">
      <header className="flex h-14 items-center justify-between bg-custom-background-100/95 px-5 border-b border-custom-border-200">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-custom-text-100">{fileName}</span>
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
            disabled={scale <= 0.25}
          >
            <ZoomOut className="size-4" />
          </Button>
          <span className="min-w-[4rem] text-center text-xs text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            onClick={handleZoomIn}
            disabled={scale >= 5}
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

      <div className="flex flex-1 items-center justify-center overflow-auto bg-custom-background-90 p-8">
        {loading && (
          <div className="text-sm text-muted-foreground">Loading video...</div>
        )}
        {error && <div className="text-sm text-destructive">{error}</div>}
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          className="transition-transform duration-200"
          style={{
            maxWidth: `${scale * 100}%`,
            maxHeight: `${scale * 100}%`,
            objectFit: "contain",
            transform: `rotate(${rotation}deg)`,
            display: loading || error ? "none" : "block",
          }}
          onLoadedMetadata={handleVideoLoadedMetadata}
          onError={handleVideoError}
        />
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
