import { AudioLines } from "lucide-react";
import { useState } from "react";

// Load results are tagged with their URL so a stale result never applies to a
// new file, and no reset effect can clobber a load that already fired.
type AudioLoad =
  | { url: string; duration: number }
  | { url: string; error: string };

interface AudioViewerProps {
  relativePath: string;
  fileName: string;
  sourceUrl: string;
}

/** `m:ss`, or `h:mm:ss` from an hour up. */
const formatDuration = (seconds: number): string => {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

export const AudioViewer = ({
  relativePath,
  fileName,
  sourceUrl,
}: AudioViewerProps) => {
  const [load, setLoad] = useState<AudioLoad | null>(null);
  const current = load?.url === sourceUrl ? load : null;
  const error = current && "error" in current ? current.error : null;
  // Streams of unknown length report an infinite duration.
  const duration =
    current && "duration" in current && Number.isFinite(current.duration)
      ? formatDuration(current.duration)
      : null;

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-90 font-workspace">
      <header className="flex h-14 items-center gap-2 bg-custom-background-100/95 px-5 border-b border-custom-border-200">
        <span className="text-sm font-medium text-custom-text-100">
          {fileName}
        </span>
        {duration && (
          <span className="text-xs text-muted-foreground">{duration}</span>
        )}
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-auto bg-custom-background-90 p-8">
        <AudioLines className="size-12 text-muted-foreground" aria-hidden />
        {error && <div className="text-sm text-destructive">{error}</div>}
        {/* biome-ignore lint/a11y/useMediaCaption: workspace files carry no caption track */}
        <audio
          key={sourceUrl}
          src={sourceUrl}
          controls
          preload="metadata"
          className="w-full max-w-xl"
          onLoadedMetadata={(event) =>
            setLoad({ url: sourceUrl, duration: event.currentTarget.duration })
          }
          onError={() =>
            setLoad({ url: sourceUrl, error: "Failed to load audio" })
          }
        />
      </div>

      <footer className="flex h-10 items-center gap-4 border-t border-custom-border-200 bg-custom-background-90 px-5 text-[12px] text-muted-foreground">
        <span>{relativePath}</span>
        {duration && <span>{duration}</span>}
      </footer>
    </div>
  );
};
