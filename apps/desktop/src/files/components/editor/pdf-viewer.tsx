import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { ZoomIn, ZoomOut, RotateCw } from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "react-pdf/dist/esm/Page/TextLayer.css";
import { Button } from "@chro/ui/button";
import { getProjectBinaryFileUrl } from "@/lib/project-client";
import { useProjectId } from "../../context/project-context";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfViewerProps {
  relativePath: string;
  fileName: string;
  contentVersion?: number;
  sourceUrl?: string;
}

export const PdfViewer = ({
  relativePath,
  fileName,
  contentVersion,
  sourceUrl,
}: PdfViewerProps) => {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const projectId = useProjectId();
  const pdfUrl = useMemo(() => {
    if (sourceUrl) return sourceUrl;
    if (!projectId) return "";
    const base = getProjectBinaryFileUrl(projectId, relativePath);
    return contentVersion ? `${base}&_v=${contentVersion}` : base;
  }, [projectId, relativePath, contentVersion, sourceUrl]);

  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setNumPages(null);
    setLoading(true);
    setError(null);
  }, [pdfUrl]);

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(prev + 0.25, 3));
  };

  const handleZoomOut = () => {
    setZoom((prev) => Math.max(prev - 0.25, 0.5));
  };

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const onDocumentLoadSuccess = useCallback(
    ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
      setLoading(false);
      setError(null);
    },
    [],
  );

  const onDocumentLoadError = useCallback((err: Error) => {
    setLoading(false);
    setError(err.message || "Failed to load PDF");
  }, []);

  const pageNumbers = useMemo(() => {
    if (!numPages) return [];
    return Array.from({ length: numPages }, (_, i) => i + 1);
  }, [numPages]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateAvailableWidth = () => {
      const styles = window.getComputedStyle(viewport);
      const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
      const nextWidth = Math.floor(
        viewport.clientWidth - paddingLeft - paddingRight,
      );
      setAvailableWidth(Math.max(240, nextWidth));
    };

    updateAvailableWidth();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateAvailableWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const pageWidth = useMemo(() => {
    if (!availableWidth) return null;
    const widthWithoutBorder = availableWidth - 2;
    return Math.max(240, Math.floor(widthWithoutBorder * zoom));
  }, [availableWidth, zoom]);

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-90 font-workspace">
      <header className="flex h-14 items-center justify-between bg-custom-background-100/95 px-5 border-b border-custom-border-200">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-custom-text-100">
            {fileName}
          </span>
          {numPages && (
            <span className="text-xs text-muted-foreground">
              {numPages} pages
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
            disabled={zoom <= 0.5}
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
            disabled={zoom >= 3}
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
        className="flex flex-1 justify-center overflow-auto bg-custom-background-90 p-8"
      >
        {loading && !error && (
          <div className="text-sm text-muted-foreground">Loading PDF...</div>
        )}
        {error && <div className="text-sm text-destructive">{error}</div>}
        {pdfUrl ? (
          <Document
            key={pdfUrl}
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={null}
            error={null}
          >
            {!loading && !error && pageWidth && (
              <div className="flex flex-col items-center gap-6">
                {pageNumbers.map((pageNumber) => (
                  <div
                    key={pageNumber}
                    className="bg-white border border-custom-border-200"
                  >
                    <Page
                      pageNumber={pageNumber}
                      width={pageWidth}
                      rotate={rotation}
                      renderTextLayer={true}
                      renderAnnotationLayer={true}
                    />
                  </div>
                ))}
              </div>
            )}
          </Document>
        ) : (
          <div className="text-sm text-muted-foreground">Preparing PDF...</div>
        )}
      </div>

      <footer className="flex h-10 items-center gap-4 border-t border-custom-border-200 bg-custom-background-90 px-5 text-[12px] text-muted-foreground">
        <span>{relativePath}</span>
        {numPages && <span>{numPages} pages</span>}
      </footer>
    </div>
  );
};
