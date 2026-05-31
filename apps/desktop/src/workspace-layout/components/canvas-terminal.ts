// Canvas terminal renderer.
//
// The Zed-style split: the Rust backend (`crates/terminal`) owns all
// emulation and ships `TerminalSnapshot`s; this module only paints them and
// translates keyboard/mouse/paste input into the bytes a shell expects. It
// deliberately knows nothing about escape-sequence parsing — that lives in
// Rust now, not in the browser.

/** A color on the wire: `"fg"`/`"bg"` (theme default), a palette index
 * `0..=255`, or an explicit `[r, g, b]` triple. Mirrors `terminal::WireColor`. */
export type WireColor = "fg" | "bg" | number | [number, number, number];

export interface CellSnapshot {
  c: string;
  fg: WireColor;
  bg: WireColor;
  flags: number;
  width: number;
}

export interface CursorSnapshot {
  line: number;
  col: number;
  shape: "block" | "underline" | "beam" | "hollow_block" | "hidden";
  visible: boolean;
}

export interface TerminalSnapshot {
  cols: number;
  rows: number;
  cursor: CursorSnapshot;
  lines: CellSnapshot[][];
  app_cursor_keys: boolean;
  bracketed_paste: boolean;
}

// Cell flag bits — must match `terminal::flag_bits`.
const FLAG_INVERSE = 0b0000_0000_0000_0001;
const FLAG_BOLD = 0b0000_0000_0000_0010;
const FLAG_ITALIC = 0b0000_0000_0000_0100;
const FLAG_UNDERLINE = 0b0000_0000_0000_1000;
const FLAG_DIM = 0b0000_0000_1000_0000;
const FLAG_HIDDEN = 0b0000_0001_0000_0000;
const FLAG_STRIKEOUT = 0b0000_0010_0000_0000;

const FONT_FAMILY =
  '"JetBrains Mono", "Menlo", "Cascadia Mono", "Consolas", "Liberation Mono", monospace';
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;

// 16-color ANSI palette (matches the previous xterm theme so the look is
// unchanged). Index 0..15 = standard + bright. Specials resolve via THEME.
const THEME = {
  foreground: "#e5e5e5",
  background: "#0a0a0a",
  cursor: "#e5e5e5",
  // Translucent overlay painted over selected cells; the alpha keeps the
  // glyphs underneath legible instead of masking them.
  selection: "rgba(120, 150, 255, 0.35)",
  palette: [
    "#1a1a1a",
    "#f87171",
    "#4ade80",
    "#facc15",
    "#60a5fa",
    "#c084fc",
    "#67e8f9",
    "#e5e5e5",
    "#525252",
    "#fca5a5",
    "#86efac",
    "#fde047",
    "#93c5fd",
    "#d8b4fe",
    "#a5f3fc",
    "#f5f5f5",
  ],
};

/** Resolve a palette index `0..=255` to a CSS color: 0–15 from the theme,
 * 16–231 from the 6×6×6 cube, 232–255 from the grayscale ramp. */
function paletteColor(index: number): string {
  if (index < 16) return THEME.palette[index];
  if (index < 232) {
    const i = index - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const channel = (v: number) => (v === 0 ? 0 : v * 40 + 55);
    return `rgb(${channel(r)},${channel(g)},${channel(b)})`;
  }
  const level = (index - 232) * 10 + 8;
  return `rgb(${level},${level},${level})`;
}

function resolveColor(color: WireColor): string {
  if (color === "fg") return THEME.foreground;
  if (color === "bg") return THEME.background;
  if (typeof color === "number") return paletteColor(color);
  return `rgb(${color[0]},${color[1]},${color[2]})`;
}

export interface CanvasTerminalCallbacks {
  /** UTF-8 bytes the shell should receive (keystrokes, pasted text). */
  onInput: (bytes: Uint8Array) => void;
  /** The visible grid changed size; backend PTY + emulator must follow. */
  onResize: (cols: number, rows: number) => void;
  /** Scrollback view request; positive scrolls toward history. */
  onScroll: (deltaLines: number) => void;
}

const encoder = new TextEncoder();

/** A cell coordinate inside the visible viewport grid. */
export interface CellPos {
  row: number;
  col: number;
}

/** An inclusive selection between two viewport cells. `anchor` is where the
 * drag started; `focus` follows the pointer. Order is normalized on read. */
interface TerminalSelection {
  anchor: CellPos;
  focus: CellPos;
}

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Return `[start, end]` in reading order (top-to-bottom, left-to-right). */
function orderPositions(a: CellPos, b: CellPos): [CellPos, CellPos] {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b];
  return [b, a];
}

// --- selection text extraction (pure; unit-tested) -------------------------

/** The character of the cell occupying `targetCol` in `line`, or "" when the
 * column falls past the row's last cell. Wide-character spacers (width 0) are
 * skipped — the wide glyph answers for both of its columns. */
export function cellCharAt(line: CellSnapshot[], targetCol: number): string {
  let col = 0;
  for (const cell of line) {
    const span = cell.width === 0 ? 0 : cell.width === 2 ? 2 : 1;
    if (span === 0) continue;
    if (targetCol >= col && targetCol < col + span) return cell.c;
    col += span;
  }
  return "";
}

/** Concatenate the characters of `line` whose columns overlap the inclusive
 * range `[fromCol, toCol]`. Empty cells contribute a single space. */
function rowText(line: CellSnapshot[], fromCol: number, toCol: number): string {
  let text = "";
  let col = 0;
  for (const cell of line) {
    const span = cell.width === 0 ? 0 : cell.width === 2 ? 2 : 1;
    if (span === 0) continue;
    if (col <= toCol && col + span - 1 >= fromCol) {
      text += cell.c === "" ? " " : cell.c;
    }
    col += span;
  }
  return text;
}

/** Flatten a selection between two viewport cells into clipboard text.
 * Trailing blanks are trimmed per line (terminals pad rows with spaces;
 * copying that padding is never useful). Returns "" for a collapsed range. */
export function selectionToText(
  snapshot: TerminalSnapshot,
  anchor: CellPos,
  focus: CellPos,
): string {
  const [start, end] = orderPositions(anchor, focus);
  if (start.row === end.row && start.col === end.col) return "";
  const lastCol = snapshot.cols - 1;
  const rows: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    const line = snapshot.lines[row];
    if (!line) {
      rows.push("");
      continue;
    }
    const fromCol = row === start.row ? start.col : 0;
    const toCol = row === end.row ? end.col : lastCol;
    rows.push(rowText(line, fromCol, toCol).replace(/\s+$/u, ""));
  }
  return rows.join("\n");
}

/** Expand `col` to the surrounding run of non-whitespace on `line`, returning
 * the inclusive `[startCol, endCol]`. A whitespace or empty cell yields
 * `[col, col]` — there is no word to select. */
export function wordRange(
  line: CellSnapshot[],
  cols: number,
  col: number,
): [number, number] {
  const isWord = (c: number): boolean => {
    const ch = cellCharAt(line, c);
    return ch.length > 0 && !/\s/u.test(ch);
  };
  if (cols === 0 || !isWord(col)) return [col, col];
  let startCol = col;
  while (startCol > 0 && isWord(startCol - 1)) startCol -= 1;
  let endCol = col;
  while (endCol < cols - 1 && isWord(endCol + 1)) endCol += 1;
  return [startCol, endCol];
}

/**
 * Owns a `<canvas>` and renders `TerminalSnapshot`s into it, forwarding input
 * through the supplied callbacks. Framework-agnostic so the React layer only
 * has to manage its lifecycle.
 */
export class CanvasTerminal {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: CanvasTerminalCallbacks;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private cellWidth = 8;
  private cellHeight = 16;
  private snapshot: TerminalSnapshot | null = null;
  private focused = false;
  // Active text selection in viewport coordinates, and whether a drag is in
  // progress. Both highlight and copy read from the live snapshot so what is
  // shown and what is copied always agree.
  private selection: TerminalSelection | null = null;
  private dragging = false;
  // Off-screen element that mirrors the terminal selection as a *real* DOM
  // selection. The macOS menu bar owns ⌘C (see src-tauri `menu.rs`) and routes
  // it through the native Copy role before any renderer keydown fires — and
  // that native copy only acts on a DOM selection. A canvas has no selectable
  // text, so without this mirror the OS copies nothing. Feeding the platform a
  // real selection makes ⌘C, the Edit▸Copy menu, and right-click Copy all work.
  private copyMirror: HTMLDivElement | null = null;
  private frameHandle: number | null = null;
  // Last grid size we reported, to debounce resize spam.
  private reportedCols = 0;
  private reportedRows = 0;

  constructor(callbacks: CanvasTerminalCallbacks) {
    this.callbacks = callbacks;
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.style.display = "block";
    this.canvas.style.outline = "none";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    // I-beam pointer signals the grid is selectable.
    this.canvas.style.cursor = "text";
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.copyMirror = this.createCopyMirror();
    this.measureCell();
    this.attachInputHandlers();
  }

  /** A visually-hidden but selectable element that holds the selection text so
   * the native Copy action has a real DOM selection to act on. Clipped to 1px
   * and transparent; `white-space: pre` so spaces and newlines survive a copy
   * even if our `copy` handler is bypassed. */
  private createCopyMirror(): HTMLDivElement {
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    const s = mirror.style;
    s.position = "absolute";
    s.top = "0";
    s.left = "0";
    s.width = "1px";
    s.height = "1px";
    s.overflow = "hidden";
    s.opacity = "0";
    s.pointerEvents = "none";
    s.whiteSpace = "pre";
    s.setProperty("user-select", "text");
    s.setProperty("-webkit-user-select", "text");
    return mirror;
  }

  /** Place the canvas in `container` and start observing it for size changes. */
  mount(container: HTMLElement): void {
    if (this.container === container) return;
    this.container = container;
    container.appendChild(this.canvas);
    if (this.copyMirror) container.appendChild(this.copyMirror);
    const observer = new ResizeObserver(() => this.syncToContainer());
    observer.observe(container);
    this.resizeObserver = observer;
    this.syncToContainer();
  }

  /** Detach from the current container without destroying state. */
  unmount(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.copyMirror?.remove();
    this.container = null;
  }

  focus(): void {
    this.canvas.focus();
  }

  setSnapshot(snapshot: TerminalSnapshot): void {
    this.snapshot = snapshot;
    this.scheduleRender();
  }

  dispose(): void {
    this.unmount();
    // Drag listeners live on `window` while a selection is in progress, and the
    // copy listener on `document`; drop both so a disposed terminal can't keep
    // reacting to the mouse or intercepting copies.
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("copy", this.onCopy);
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
  }

  // --- internals -----------------------------------------------------------

  private measureCell(): void {
    this.ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    const advance = this.ctx.measureText("M").width;
    this.cellWidth = Math.max(1, Math.round(advance));
    this.cellHeight = Math.max(1, Math.ceil(FONT_SIZE * LINE_HEIGHT));
  }

  /** Resize the backing store to the container and recompute the grid. */
  private syncToContainer(): void {
    const container = this.container;
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.measureCell();

    const cols = Math.max(1, Math.floor(width / this.cellWidth));
    const rows = Math.max(1, Math.floor(height / this.cellHeight));
    if (cols !== this.reportedCols || rows !== this.reportedRows) {
      this.reportedCols = cols;
      this.reportedRows = rows;
      // The grid reflowed; old selection coordinates no longer line up.
      this.clearSelection();
      this.callbacks.onResize(cols, rows);
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
    const snapshot = this.snapshot;
    const ctx = this.ctx;
    ctx.fillStyle = THEME.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!snapshot) return;

    ctx.textBaseline = "top";
    const baseFont = `${FONT_SIZE}px ${FONT_FAMILY}`;

    for (let row = 0; row < snapshot.lines.length; row++) {
      const cells = snapshot.lines[row];
      const y = row * this.cellHeight;
      let col = 0;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        if (cell.width === 0) {
          continue; // trailing spacer of a wide char
        }
        const x = col * this.cellWidth;
        const span = cell.width === 2 ? 2 : 1;
        const inverse = (cell.flags & FLAG_INVERSE) !== 0;
        let fg = resolveColor(cell.fg);
        let bg = resolveColor(cell.bg);
        if (inverse) [fg, bg] = [bg, fg];

        // Background.
        if (bg !== THEME.background) {
          ctx.fillStyle = bg;
          ctx.fillRect(x, y, this.cellWidth * span, this.cellHeight);
        }

        // Glyph.
        if (
          cell.c !== " " &&
          cell.c !== "" &&
          (cell.flags & FLAG_HIDDEN) === 0
        ) {
          const bold = (cell.flags & FLAG_BOLD) !== 0;
          const italic = (cell.flags & FLAG_ITALIC) !== 0;
          ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${baseFont}`;
          ctx.globalAlpha = (cell.flags & FLAG_DIM) !== 0 ? 0.6 : 1;
          ctx.fillStyle = fg;
          ctx.fillText(cell.c, x, y);
          ctx.globalAlpha = 1;

          if ((cell.flags & FLAG_UNDERLINE) !== 0) {
            ctx.fillStyle = fg;
            ctx.fillRect(x, y + this.cellHeight - 2, this.cellWidth * span, 1);
          }
          if ((cell.flags & FLAG_STRIKEOUT) !== 0) {
            ctx.fillStyle = fg;
            ctx.fillRect(
              x,
              y + Math.floor(this.cellHeight / 2),
              this.cellWidth * span,
              1,
            );
          }
        }
        col += span;
      }
    }

    this.renderSelection(snapshot);
    this.renderCursor(snapshot);
  }

  private renderCursor(snapshot: TerminalSnapshot): void {
    const cursor = snapshot.cursor;
    if (!cursor.visible || cursor.shape === "hidden") return;
    if (cursor.line < 0 || cursor.line >= snapshot.rows) return;
    const ctx = this.ctx;
    const x = cursor.col * this.cellWidth;
    const y = cursor.line * this.cellHeight;
    ctx.fillStyle = THEME.cursor;

    if (!this.focused) {
      // Unfocused: hollow box so it's clear which pane has input.
      ctx.strokeStyle = THEME.cursor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, this.cellWidth - 1, this.cellHeight - 1);
      return;
    }

    if (cursor.shape === "beam") {
      ctx.fillRect(x, y, 2, this.cellHeight);
      return;
    }
    if (cursor.shape === "underline") {
      ctx.fillRect(x, y + this.cellHeight - 2, this.cellWidth, 2);
      return;
    }
    // Block / hollow_block when focused: filled block with inverted glyph.
    ctx.fillRect(x, y, this.cellWidth, this.cellHeight);
    const cell = snapshot.lines[cursor.line]?.[cursor.col];
    if (cell?.c && cell.c !== " ") {
      ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
      ctx.fillStyle = THEME.background;
      ctx.fillText(cell.c, x, y);
    }
  }

  // --- selection -----------------------------------------------------------

  /** Paint the translucent highlight over the selected cell range. Drawn
   * after glyphs so the text stays readable through the overlay. */
  private renderSelection(snapshot: TerminalSnapshot): void {
    const selection = this.selection;
    if (!selection) return;
    const [start, end] = orderPositions(selection.anchor, selection.focus);
    if (start.row === end.row && start.col === end.col) return;

    const ctx = this.ctx;
    ctx.fillStyle = THEME.selection;
    const lastCol = snapshot.cols - 1;
    for (let row = start.row; row <= end.row; row++) {
      const fromCol = row === start.row ? start.col : 0;
      const toCol = row === end.row ? end.col : lastCol;
      const x = fromCol * this.cellWidth;
      const width = (toCol - fromCol + 1) * this.cellWidth;
      ctx.fillRect(x, row * this.cellHeight, width, this.cellHeight);
    }
  }

  /** Translate a pointer event into the viewport cell beneath it, clamped to
   * the grid so drags that leave the canvas still resolve to an edge cell. */
  private eventToCell(event: MouseEvent): CellPos {
    const rect = this.canvas.getBoundingClientRect();
    const cols = this.snapshot?.cols ?? this.reportedCols;
    const rows = this.snapshot?.rows ?? this.reportedRows;
    const col = clamp(
      Math.floor((event.clientX - rect.left) / this.cellWidth),
      0,
      Math.max(0, cols - 1),
    );
    const row = clamp(
      Math.floor((event.clientY - rect.top) / this.cellHeight),
      0,
      Math.max(0, rows - 1),
    );
    return { row, col };
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return; // selection is a left-button gesture
    event.preventDefault();
    this.canvas.focus();
    const pos = this.eventToCell(event);

    // Double-click selects a word, triple-click the whole line.
    if (event.detail === 2) {
      this.selection = this.wordSelection(pos);
      this.syncCopyMirror();
      this.scheduleRender();
      return;
    }
    if (event.detail >= 3) {
      this.selection = this.lineSelection(pos.row);
      this.syncCopyMirror();
      this.scheduleRender();
      return;
    }

    // Shift-click extends the current selection from its existing anchor.
    this.selection =
      event.shiftKey && this.selection
        ? { anchor: this.selection.anchor, focus: pos }
        : { anchor: pos, focus: pos };
    this.dragging = true;
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    this.scheduleRender();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.dragging || !this.selection) return;
    this.selection = {
      anchor: this.selection.anchor,
      focus: this.eventToCell(event),
    };
    this.scheduleRender();
  };

  private readonly onMouseUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    // A click with no drag collapses to a single cell — treat it as "clear"
    // so a stray click doesn't leave a one-cell selection lingering.
    if (this.selection) {
      const { anchor, focus } = this.selection;
      if (anchor.row === focus.row && anchor.col === focus.col) {
        this.selection = null;
        this.clearCopyMirror();
        this.scheduleRender();
        return;
      }
    }
    // Drag finished with a real range — publish it for the native copy path.
    this.syncCopyMirror();
  };

  /** Expand a click position to the surrounding run of non-whitespace. */
  private wordSelection(pos: CellPos): TerminalSelection {
    const line = this.snapshot?.lines[pos.row];
    if (!line) return { anchor: pos, focus: pos };
    const cols = this.snapshot?.cols ?? 0;
    const [startCol, endCol] = wordRange(line, cols, pos.col);
    return {
      anchor: { row: pos.row, col: startCol },
      focus: { row: pos.row, col: endCol },
    };
  }

  private lineSelection(row: number): TerminalSelection {
    const lastCol = Math.max(0, (this.snapshot?.cols ?? 1) - 1);
    return { anchor: { row, col: 0 }, focus: { row, col: lastCol } };
  }

  private clearSelection(): void {
    if (!this.selection) return;
    this.selection = null;
    this.clearCopyMirror();
    this.scheduleRender();
  }

  /** Mirror the current terminal selection into a real DOM selection so the
   * native Copy action has something to act on. No-op for an empty selection. */
  private syncCopyMirror(): void {
    const mirror = this.copyMirror;
    const selection = this.selection;
    if (!mirror) return;
    const text =
      selection && this.snapshot
        ? selectionToText(this.snapshot, selection.anchor, selection.focus)
        : "";
    if (!text) {
      this.clearCopyMirror();
      return;
    }
    mirror.textContent = text;
    const domSelection = window.getSelection();
    if (!domSelection) return;
    const range = document.createRange();
    range.selectNodeContents(mirror);
    domSelection.removeAllRanges();
    domSelection.addRange(range);
  }

  /** Drop the mirror text, and collapse the DOM selection only when it still
   * points into our mirror (never disturb a selection the user made elsewhere). */
  private clearCopyMirror(): void {
    const mirror = this.copyMirror;
    if (!mirror) return;
    const domSelection = window.getSelection();
    if (domSelection && mirror.contains(domSelection.anchorNode)) {
      domSelection.removeAllRanges();
    }
    mirror.textContent = "";
  }

  /** Serve the native Copy action: when this terminal is focused and has a
   * selection, write its exact text and pre-empt the browser's default copy. */
  private readonly onCopy = (event: ClipboardEvent): void => {
    if (document.activeElement !== this.canvas) return;
    const selection = this.selection;
    if (!selection || !this.snapshot) return;
    const text = selectionToText(
      this.snapshot,
      selection.anchor,
      selection.focus,
    );
    if (!text) return;
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  };

  // --- input ---------------------------------------------------------------

  private attachInputHandlers(): void {
    this.canvas.addEventListener("keydown", this.onKeyDown);
    this.canvas.addEventListener("paste", this.onPaste);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("focus", () => {
      this.focused = true;
      this.scheduleRender();
    });
    this.canvas.addEventListener("blur", () => {
      this.focused = false;
      this.scheduleRender();
    });
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    // The native Copy action dispatches a `copy` event (target depends on where
    // the DOM selection lives); listen on `document` and gate on focus so only
    // the active terminal answers, then write the exact selection text.
    document.addEventListener("copy", this.onCopy);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Cmd shortcuts (copy via the native Copy role, paste, devtools) belong to
    // the browser / OS — copy is served by `onCopy` off the mirror selection.
    if (event.metaKey) return;
    const sequence = encodeKey(event, this.snapshot?.app_cursor_keys ?? false);
    if (sequence === null) return;
    event.preventDefault();
    // Typing supersedes any selection and would scroll it out of view anyway.
    this.clearSelection();
    this.callbacks.onInput(encoder.encode(sequence));
  };

  private readonly onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    this.clearSelection();
    const wrapped = this.snapshot?.bracketed_paste
      ? `\x1b[200~${text}\x1b[201~`
      : text;
    this.callbacks.onInput(encoder.encode(wrapped));
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Scrolling shifts the viewport; the selection's coordinates would no
    // longer map to the same text, so drop it.
    this.clearSelection();
    const lines = Math.max(
      1,
      Math.round(Math.abs(event.deltaY) / this.cellHeight),
    );
    // Wheel up (deltaY < 0) reveals history → positive delta.
    this.callbacks.onScroll(event.deltaY < 0 ? lines : -lines);
  };
}

/**
 * Translate a DOM keydown into the byte sequence a terminal expects, or
 * `null` when the key isn't ours to handle. `appCursor` selects between
 * normal (`ESC [ A`) and application (`ESC O A`) cursor-key encodings.
 */
export function encodeKey(
  event: KeyboardEvent,
  appCursor: boolean,
): string | null {
  const { key, ctrlKey, altKey } = event;
  const cursor = (final: string) => `\x1b${appCursor ? "O" : "["}${final}`;

  switch (key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return event.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return cursor("A");
    case "ArrowDown":
      return cursor("B");
    case "ArrowRight":
      return cursor("C");
    case "ArrowLeft":
      return cursor("D");
    case "Home":
      return cursor("H");
    case "End":
      return cursor("F");
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Insert":
      return "\x1b[2~";
    case "Delete":
      return "\x1b[3~";
    case "F1":
      return "\x1bOP";
    case "F2":
      return "\x1bOQ";
    case "F3":
      return "\x1bOR";
    case "F4":
      return "\x1bOS";
    case "F5":
      return "\x1b[15~";
    case "F6":
      return "\x1b[17~";
    case "F7":
      return "\x1b[18~";
    case "F8":
      return "\x1b[19~";
    case "F9":
      return "\x1b[20~";
    case "F10":
      return "\x1b[21~";
    case "F11":
      return "\x1b[23~";
    case "F12":
      return "\x1b[24~";
  }

  // Printable single characters (and their Ctrl/Alt combinations).
  if (key.length === 1) {
    if (ctrlKey) {
      const code = controlCode(key);
      if (code !== null) return String.fromCharCode(code);
      return null;
    }
    // Treat Alt/Option as Meta: prefix ESC (matches the old macOptionIsMeta).
    if (altKey) return `\x1b${key}`;
    return key;
  }

  return null;
}

/** Map a key to its Ctrl control code, or `null` if there isn't one. */
function controlCode(key: string): number | null {
  const upper = key.toUpperCase();
  if (upper >= "A" && upper <= "Z") return upper.charCodeAt(0) - 64; // ^A..^Z
  switch (key) {
    case " ":
      return 0; // ^Space -> NUL
    case "[":
      return 0x1b;
    case "\\":
      return 0x1c;
    case "]":
      return 0x1d;
    case "^":
      return 0x1e;
    case "_":
      return 0x1f;
    default:
      return null;
  }
}
