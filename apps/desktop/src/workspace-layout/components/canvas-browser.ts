// Canvas browser renderer.
//
// The Rust backend (`crates/browser`) owns one CDP WebSocket to a real Chrome
// and streams JPEG screencast frames;
// this module only paints them and translates pointer/keyboard input into the
// CSS-pixel coordinates CDP `Input.*` expects. It speaks no CDP itself.

/** `Page.screencastFrame.metadata` — geometry to map a painted pixel back to a
 * CSS-pixel coordinate in the page. Mirrors `browser::ScreencastMetadata`. */
export interface ScreencastMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

export type MouseButton = "left" | "middle" | "right";

export interface CanvasBrowserCallbacks {
  /** A click at viewport (CSS-pixel) coordinates. */
  onClick: (x: number, y: number, button: MouseButton, clicks: number) => void;
  /** A wheel scroll at viewport coordinates. */
  onScroll: (x: number, y: number, dx: number, dy: number) => void;
  /** A key press; `modifiers` is the CDP bitfield (1=Alt 2=Ctrl 4=Meta 8=Shift). */
  onKey: (key: string, modifiers: number) => void;
  /** The pane changed size; the backend should restream at these dimensions. */
  onResize: (width: number, height: number) => void;
}

/** CDP modifier bitfield from a DOM keyboard/mouse event. */
function modifierBits(e: KeyboardEvent | MouseEvent | WheelEvent): number {
  let bits = 0;
  if (e.altKey) bits |= 1;
  if (e.ctrlKey) bits |= 2;
  if (e.metaKey) bits |= 4;
  if (e.shiftKey) bits |= 8;
  return bits;
}

/** Keys we forward as-is. Printable single characters fall through `e.key`. */
const FORWARDED_NONPRINTABLE = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "Delete",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * Owns a `<canvas>`, paints screencast frames into it, and forwards input
 * through the supplied callbacks. Framework-agnostic so the React layer only
 * manages its lifecycle.
 */
export class CanvasBrowser {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: CanvasBrowserCallbacks;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private frame: ImageBitmap | null = null;
  private metadata: ScreencastMetadata | null = null;
  /** Where the current frame is painted, in canvas backing pixels. */
  private drawRect = { x: 0, y: 0, width: 0, height: 0 };
  private frameHandle: number | null = null;
  private reportedWidth = 0;
  private reportedHeight = 0;
  /** Guards against painting a frame decoded after disposal. */
  private decodeToken = 0;

  constructor(callbacks: CanvasBrowserCallbacks) {
    this.callbacks = callbacks;
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.style.display = "block";
    this.canvas.style.outline = "none";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.cursor = "default";
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.attachInputHandlers();
  }

  mount(container: HTMLElement): void {
    if (this.container === container) return;
    this.container = container;
    container.appendChild(this.canvas);
    const observer = new ResizeObserver(() => this.syncToContainer());
    observer.observe(container);
    this.resizeObserver = observer;
    this.syncToContainer();
  }

  unmount(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.container = null;
  }

  focus(): void {
    this.canvas.focus();
  }

  /** Decode and paint a base64 JPEG screencast frame. */
  setFrame(base64Jpeg: string, metadata: ScreencastMetadata): void {
    this.metadata = metadata;
    const token = ++this.decodeToken;
    const blob = base64ToBlob(base64Jpeg, "image/jpeg");
    createImageBitmap(blob)
      .then((bitmap) => {
        // A newer frame (or disposal) raced ahead — discard this one.
        if (token !== this.decodeToken) {
          bitmap.close();
          return;
        }
        this.frame?.close();
        this.frame = bitmap;
        this.scheduleRender();
      })
      .catch(() => {
        /* malformed frame; the next one repaints */
      });
  }

  dispose(): void {
    // Bump the token so any in-flight decode is dropped on resolve.
    this.decodeToken++;
    this.unmount();
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frame?.close();
    this.frame = null;
  }

  // --- internals -----------------------------------------------------------

  private syncToContainer(): void {
    const container = this.container;
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);

    // Report device-pixel dimensions so the backend caps the screencast at our
    // real resolution (crisp on hidpi) without over-streaming.
    const reportW = Math.floor(width * dpr);
    const reportH = Math.floor(height * dpr);
    if (reportW !== this.reportedWidth || reportH !== this.reportedHeight) {
      this.reportedWidth = reportW;
      this.reportedHeight = reportH;
      this.callbacks.onResize(reportW, reportH);
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = null;
      this.render();
    });
  }

  private render(): void {
    const ctx = this.ctx;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const frame = this.frame;
    if (!frame) return;

    // Contain-fit: preserve the frame's aspect ratio, letterboxing the rest.
    const scale = Math.min(
      this.canvas.width / frame.width,
      this.canvas.height / frame.height,
    );
    const drawWidth = frame.width * scale;
    const drawHeight = frame.height * scale;
    const x = (this.canvas.width - drawWidth) / 2;
    const y = (this.canvas.height - drawHeight) / 2;
    this.drawRect = { x, y, width: drawWidth, height: drawHeight };
    ctx.drawImage(frame, x, y, drawWidth, drawHeight);
  }

  /**
   * Map a DOM pointer event to viewport CSS-pixel coordinates in the page.
   * Returns null when the click lands in the letterbox margin or before a
   * frame exists.
   */
  private toPageCoords(e: MouseEvent): { x: number; y: number } | null {
    const frame = this.frame;
    const metadata = this.metadata;
    if (!frame || !metadata || this.drawRect.width === 0) return null;

    const rect = this.canvas.getBoundingClientRect();
    // CSS px within the canvas element → canvas backing px.
    const backingX = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    const backingY =
      (e.clientY - rect.top) * (this.canvas.height / rect.height);

    // Backing px → frame-image px (undo the contain-fit transform).
    const imageX =
      (backingX - this.drawRect.x) / (this.drawRect.width / frame.width);
    const imageY =
      (backingY - this.drawRect.y) / (this.drawRect.height / frame.height);
    if (
      imageX < 0 ||
      imageY < 0 ||
      imageX > frame.width ||
      imageY > frame.height
    ) {
      return null;
    }

    // Frame-image px → page viewport CSS px. The frame is the device viewport
    // scaled to fit maxWidth/maxHeight, so the ratio to deviceWidth/Height
    // recovers CSS pixels regardless of the streamed resolution.
    const cssX = (imageX / frame.width) * metadata.deviceWidth;
    const cssY = (imageY / frame.height) * metadata.deviceHeight;
    return { x: cssX, y: cssY };
  }

  private attachInputHandlers(): void {
    this.canvas.addEventListener("mousedown", (e) => {
      this.canvas.focus();
      const coords = this.toPageCoords(e);
      if (!coords) return;
      e.preventDefault();
      const button: MouseButton =
        e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
      this.callbacks.onClick(coords.x, coords.y, button, e.detail || 1);
    });

    // Suppress the native context menu so right-click reaches the page.
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        const coords = this.toPageCoords(e);
        if (!coords) return;
        e.preventDefault();
        // CDP wheel deltas use the same sign convention as the DOM event.
        this.callbacks.onScroll(coords.x, coords.y, e.deltaX, e.deltaY);
      },
      { passive: false },
    );

    this.canvas.addEventListener("keydown", (e) => {
      const printable = e.key.length === 1;
      if (!printable && !FORWARDED_NONPRINTABLE.has(e.key)) return;
      e.preventDefault();
      this.callbacks.onKey(e.key, modifierBits(e));
    });
  }
}

/** Decode a base64 string to a Blob without a data-URL round trip. */
function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}
