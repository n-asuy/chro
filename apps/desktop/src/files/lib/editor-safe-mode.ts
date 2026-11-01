/**
 * Safe mode bounds the cost of rendering a file *inside our own process*.
 * Prose decorations, syntax highlighting and line wrapping all scale with
 * document size, as do the tabular viewers that parse the whole file up front
 * (spreadsheet, base).
 *
 * Byte size is only a proxy for that cost. A drawing scene's bytes are mostly
 * embedded base64 images, which the canvas decodes as images rather than text,
 * so its render cost follows the element count and the threshold does not
 * apply to it.
 *
 * It must never gate a view that hands the file to another renderer: the HTML
 * preview points an iframe at the asset URL, so the bytes are fetched and laid
 * out by the browser and never reach the editor. Size is irrelevant there, and
 * suppressing the preview only leaves the file unviewable.
 */

export const LARGE_TEXT_SAFE_MODE_BYTES = 512 * 1024;

export type HtmlViewMode = "preview" | "raw";

export const isLargeTextSafeMode = (
  sizeInBytes: number | null | undefined,
): boolean => (sizeInBytes ?? 0) > LARGE_TEXT_SAFE_MODE_BYTES;

/** Viewers that replace the text editor with a parsed view of the file. */
export type StructuredViewer = "scene" | "base" | "spreadsheet";

export const opensInStructuredViewer = (
  viewer: StructuredViewer,
  sizeInBytes: number | null | undefined,
): boolean => viewer === "scene" || !isLargeTextSafeMode(sizeInBytes);

export type CodeViewInput = {
  fileSizeBytes: number | null | undefined;
  isHtml: boolean;
  htmlViewMode: HtmlViewMode;
  fullscreenRequested: boolean;
};

export type CodeViewState = {
  /** Text is rendered undecorated because the document is large. */
  largeTextSafeMode: boolean;
  showHtmlPreview: boolean;
  /** Preview/Raw switch and the preview-only refresh + fullscreen buttons. */
  showHtmlToolbar: boolean;
  showHtmlFullscreen: boolean;
  /** The banner only makes sense while the degraded text view is on screen. */
  showSafeModeNotice: boolean;
  syntaxHighlighting: boolean;
  lineWrapping: boolean;
};

/**
 * Resolves what the code/raw editor branch shows. Every safe-mode consequence
 * is derived here so the rule stays in one place instead of being re-stated at
 * each render site.
 */
export const resolveCodeViewState = ({
  fileSizeBytes,
  isHtml,
  htmlViewMode,
  fullscreenRequested,
}: CodeViewInput): CodeViewState => {
  const largeTextSafeMode = isLargeTextSafeMode(fileSizeBytes);
  const showHtmlPreview = isHtml && htmlViewMode === "preview";
  return {
    largeTextSafeMode,
    showHtmlPreview,
    showHtmlToolbar: isHtml,
    showHtmlFullscreen: showHtmlPreview && fullscreenRequested,
    showSafeModeNotice: largeTextSafeMode && !showHtmlPreview,
    syntaxHighlighting: !largeTextSafeMode,
    lineWrapping: !largeTextSafeMode,
  };
};
