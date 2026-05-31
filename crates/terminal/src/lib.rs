//! Headless terminal emulator.
//!
//! This is the backend half of a Zed-style terminal split: all emulation —
//! VTE parsing, the cell grid, scrollback, cursor and color state — lives here
//! in Rust on top of [`alacritty_terminal`], mirroring Zed's `terminal` crate
//! but without GPUI. The renderer (a thin canvas in the desktop app) is fed
//! [`TerminalSnapshot`]s and never parses escape sequences itself.
//!
//! The emulator owns no PTY and performs no I/O. Callers drive it by feeding
//! raw master bytes into [`Emulator::advance`] and writing the returned
//! [`EmulatorOutput::pty_writes`] back to their PTY (these carry the terminal's
//! own replies to device queries — cursor reports, color queries, and so on).

use std::sync::{Arc, Mutex};

use alacritty_terminal::{
    event::{Event, EventListener, WindowSize},
    grid::Dimensions,
    term::{cell::Flags, Config, TermMode},
    vte::ansi::{Color as AnsiColor, CursorShape, NamedColor, Processor},
    Term,
};
use serde::Serialize;

/// Default scrollback retained above the viewport, in lines.
const DEFAULT_SCROLLBACK: usize = 5_000;
/// Hard ceiling on scrollback so a runaway `cols`/`rows` request can't pin
/// unbounded memory.
const MAX_SCROLLBACK: usize = 100_000;
/// Pixel cell metrics reported to programs that query the text-area size. The
/// renderer uses its own font metrics; these only need to be non-zero so
/// size-aware programs receive a sane aspect ratio.
const CELL_WIDTH_PX: u16 = 7;
const CELL_HEIGHT_PX: u16 = 15;

/// Collects [`Event`]s emitted by the terminal during a parse pass so the
/// caller can act on them once the mutable borrow of the grid has ended.
#[derive(Clone)]
struct EventProxy(Arc<Mutex<Vec<Event>>>);

impl EventProxy {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Vec::new())))
    }

    fn drain(&self) -> Vec<Event> {
        std::mem::take(&mut *self.0.lock().expect("event proxy mutex poisoned"))
    }
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        self.0
            .lock()
            .expect("event proxy mutex poisoned")
            .push(event);
    }
}

/// Viewport dimensions handed to alacritty. Scrollback is configured
/// separately via [`Config::scrolling_history`], so `total_lines` is just the
/// visible height here.
#[derive(Clone, Copy)]
struct TermDimensions {
    columns: usize,
    screen_lines: usize,
}

impl Dimensions for TermDimensions {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }
    fn screen_lines(&self) -> usize {
        self.screen_lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

/// Side effects produced by a single [`Emulator::advance`] call.
#[derive(Debug, Default)]
pub struct EmulatorOutput {
    /// Bytes the terminal wants written back to the PTY (device-status
    /// replies, color queries, etc.). Empty in the common case.
    pub pty_writes: Vec<u8>,
    /// The window title changed (OSC 0/2). Read it via [`Emulator::title`].
    pub title_changed: bool,
    /// The terminal rang the bell (BEL).
    pub bell: bool,
}

/// A headless terminal: a parser plus the alacritty grid it drives.
pub struct Emulator {
    term: Term<EventProxy>,
    parser: Processor,
    proxy: EventProxy,
    size: TermDimensions,
    title: Option<String>,
}

impl Emulator {
    /// Create an emulator with the given viewport and a default scrollback.
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::with_scrollback(cols, rows, DEFAULT_SCROLLBACK)
    }

    /// Create an emulator with an explicit scrollback depth (clamped to
    /// [`MAX_SCROLLBACK`]).
    pub fn with_scrollback(cols: u16, rows: u16, scrollback: usize) -> Self {
        let size = TermDimensions {
            columns: (cols.max(1)) as usize,
            screen_lines: (rows.max(1)) as usize,
        };
        let config = Config {
            scrolling_history: scrollback.min(MAX_SCROLLBACK),
            ..Config::default()
        };
        let proxy = EventProxy::new();
        let term = Term::new(config, &size, proxy.clone());
        Self {
            term,
            parser: Processor::new(),
            proxy,
            size,
            title: None,
        }
    }

    /// Feed raw PTY bytes through the parser, mutating the grid.
    pub fn advance(&mut self, bytes: &[u8]) -> EmulatorOutput {
        self.parser.advance(&mut self.term, bytes);
        self.collect_output()
    }

    fn collect_output(&mut self) -> EmulatorOutput {
        let mut output = EmulatorOutput::default();
        for event in self.proxy.drain() {
            match event {
                Event::PtyWrite(text) => output.pty_writes.extend_from_slice(text.as_bytes()),
                Event::ColorRequest(index, formatter) => {
                    let rgb = self.term.colors()[index].unwrap_or_default();
                    output
                        .pty_writes
                        .extend_from_slice(formatter(rgb).as_bytes());
                }
                Event::TextAreaSizeRequest(formatter) => {
                    let reply = formatter(self.window_size());
                    output.pty_writes.extend_from_slice(reply.as_bytes());
                }
                Event::Title(title) => {
                    self.title = Some(title);
                    output.title_changed = true;
                }
                Event::ResetTitle => {
                    self.title = None;
                    output.title_changed = true;
                }
                Event::Bell => output.bell = true,
                // Clipboard, mouse-cursor, and wakeup hints have no headless
                // analogue; the renderer reconstructs everything it needs from
                // the snapshot.
                _ => {}
            }
        }
        output
    }

    /// Resize the viewport. Reflows existing content per alacritty's rules.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let size = TermDimensions {
            columns: (cols.max(1)) as usize,
            screen_lines: (rows.max(1)) as usize,
        };
        self.size = size;
        self.term.resize(size);
    }

    /// Scroll the viewport by `delta` lines (positive scrolls toward history).
    pub fn scroll_lines(&mut self, delta: i32) {
        use alacritty_terminal::grid::Scroll;
        self.term.scroll_display(Scroll::Delta(delta));
    }

    /// The current window title, if the program set one.
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    fn window_size(&self) -> WindowSize {
        WindowSize {
            num_lines: self.size.screen_lines as u16,
            num_cols: self.size.columns as u16,
            cell_width: CELL_WIDTH_PX,
            cell_height: CELL_HEIGHT_PX,
        }
    }

    /// Capture the visible viewport (plus cursor) as a serializable snapshot.
    pub fn snapshot(&self) -> TerminalSnapshot {
        let content = self.term.renderable_content();
        let cols = self.size.columns;
        let rows = self.size.screen_lines;
        let display_offset = content.display_offset as i32;

        // `display_iter` yields points whose line is `-display_offset` at the
        // top of the viewport; shift back into a dense `0..rows` row index.
        let mut lines: Vec<Vec<CellSnapshot>> =
            (0..rows).map(|_| Vec::with_capacity(cols)).collect();

        for indexed in content.display_iter {
            let row = (indexed.point.line.0 + display_offset) as usize;
            if row >= rows {
                continue;
            }
            lines[row].push(CellSnapshot::from_cell(indexed.cell));
        }

        let cursor_row = content.cursor.point.line.0 + display_offset;
        let cursor = CursorSnapshot {
            line: cursor_row,
            col: content.cursor.point.column.0 as u16,
            shape: CursorShapeKind::from(content.cursor.shape),
            visible: content.cursor.shape != CursorShape::Hidden
                && cursor_row >= 0
                && (cursor_row as usize) < rows,
        };

        TerminalSnapshot {
            cols: cols as u16,
            rows: rows as u16,
            cursor,
            lines,
            app_cursor_keys: content.mode.contains(TermMode::APP_CURSOR),
            bracketed_paste: content.mode.contains(TermMode::BRACKETED_PASTE),
        }
    }
}

/// A point-in-time view of the terminal: a dense grid of cells plus the
/// cursor. This is the entire contract with the renderer.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalSnapshot {
    pub cols: u16,
    pub rows: u16,
    pub cursor: CursorSnapshot,
    /// `rows` rows, each holding up to `cols` cells in column order. A wide
    /// character's trailing spacer is emitted as an empty cell of width 0.
    pub lines: Vec<Vec<CellSnapshot>>,
    /// DECCKM: the program wants cursor keys as `ESC O A` rather than `ESC [ A`.
    pub app_cursor_keys: bool,
    /// The program enabled bracketed paste; pasted text must be wrapped in
    /// `ESC [ 200 ~` / `ESC [ 201 ~`.
    pub bracketed_paste: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CursorSnapshot {
    /// Viewport row (may be negative or `>= rows` when scrolled away).
    pub line: i32,
    pub col: u16,
    pub shape: CursorShapeKind,
    pub visible: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorShapeKind {
    Block,
    Underline,
    Beam,
    HollowBlock,
    Hidden,
}

impl From<CursorShape> for CursorShapeKind {
    fn from(shape: CursorShape) -> Self {
        match shape {
            CursorShape::Block => CursorShapeKind::Block,
            CursorShape::Underline => CursorShapeKind::Underline,
            CursorShape::Beam => CursorShapeKind::Beam,
            CursorShape::HollowBlock => CursorShapeKind::HollowBlock,
            CursorShape::Hidden => CursorShapeKind::Hidden,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CellSnapshot {
    /// The cell's grapheme: the base character followed by any zero-width
    /// combining marks. Empty for a wide-character spacer.
    pub c: String,
    pub fg: WireColor,
    pub bg: WireColor,
    /// Raw [`Flags`] bits (bold, italic, underline, inverse, …). The renderer
    /// interprets these; see [`flag_bits`].
    pub flags: u16,
    /// Display width in cells: 1 normally, 2 for a wide char, 0 for its spacer.
    pub width: u8,
}

impl CellSnapshot {
    fn from_cell(cell: &alacritty_terminal::term::cell::Cell) -> Self {
        let flags = cell.flags;
        let width = if flags.contains(Flags::WIDE_CHAR) {
            2
        } else if flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            0
        } else {
            1
        };

        // A spacer carries no glyph; the preceding wide char already drew it.
        let c = if width == 0 {
            String::new()
        } else {
            let mut s = String::new();
            s.push(cell.c);
            if let Some(zerowidth) = cell.zerowidth() {
                s.extend(zerowidth.iter().copied());
            }
            s
        };

        Self {
            c,
            fg: WireColor::from(cell.fg),
            bg: WireColor::from(cell.bg),
            flags: flags.bits(),
            width,
        }
    }
}

/// Compact color encoding. Serialized untagged so each shape is distinct in
/// JSON: a string for a theme default (`"fg"`/`"bg"`), a number for a palette
/// slot (`0..=255`), or a `[r, g, b]` array for a true-color value. The
/// renderer maps palette slots `0..=15` to its theme and `16..=255` to the
/// standard xterm-256 cube.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum WireColor {
    Default(&'static str),
    Palette(u8),
    Rgb([u8; 3]),
}

impl From<AnsiColor> for WireColor {
    fn from(color: AnsiColor) -> Self {
        match color {
            AnsiColor::Spec(rgb) => WireColor::Rgb([rgb.r, rgb.g, rgb.b]),
            AnsiColor::Indexed(index) => WireColor::Palette(index),
            AnsiColor::Named(named) => match named {
                NamedColor::Background => WireColor::Default("bg"),
                NamedColor::Foreground
                | NamedColor::BrightForeground
                | NamedColor::DimForeground
                | NamedColor::Cursor => WireColor::Default("fg"),
                other => {
                    let index = other as usize;
                    if index < 16 {
                        // Standard ANSI 0..15.
                        WireColor::Palette(index as u8)
                    } else if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize)
                        .contains(&index)
                    {
                        // Dim variants collapse to their base ANSI slot; the
                        // DIM flag on the cell carries the dimming intent.
                        WireColor::Palette((index - NamedColor::DimBlack as usize) as u8)
                    } else {
                        WireColor::Default("fg")
                    }
                }
            },
        }
    }
}

/// Bit positions of [`Flags`] the renderer cares about, re-exported so the
/// wire contract is documented in one place. Mirrors `alacritty_terminal`.
pub mod flag_bits {
    pub const INVERSE: u16 = 0b0000_0000_0000_0001;
    pub const BOLD: u16 = 0b0000_0000_0000_0010;
    pub const ITALIC: u16 = 0b0000_0000_0000_0100;
    pub const UNDERLINE: u16 = 0b0000_0000_0000_1000;
    pub const DIM: u16 = 0b0000_0000_1000_0000;
    pub const HIDDEN: u16 = 0b0000_0001_0000_0000;
    pub const STRIKEOUT: u16 = 0b0000_0010_0000_0000;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_text(snapshot: &TerminalSnapshot, row: usize) -> String {
        snapshot.lines[row]
            .iter()
            .map(|cell| cell.c.as_str())
            .collect()
    }

    #[test]
    fn writes_plain_text_into_the_grid() {
        let mut emulator = Emulator::new(20, 5);
        emulator.advance(b"hello");
        let snapshot = emulator.snapshot();
        assert_eq!(snapshot.cols, 20);
        assert_eq!(snapshot.rows, 5);
        assert!(row_text(&snapshot, 0).starts_with("hello"));
        assert_eq!(snapshot.cursor.line, 0);
        assert_eq!(snapshot.cursor.col, 5);
    }

    #[test]
    fn newline_advances_cursor_row() {
        let mut emulator = Emulator::new(20, 5);
        emulator.advance(b"a\r\nb");
        let snapshot = emulator.snapshot();
        assert!(row_text(&snapshot, 0).starts_with("a"));
        assert!(row_text(&snapshot, 1).starts_with("b"));
        assert_eq!(snapshot.cursor.line, 1);
    }

    #[test]
    fn sgr_bold_sets_the_bold_flag() {
        let mut emulator = Emulator::new(20, 5);
        // ESC[1m -> bold, then 'X'.
        emulator.advance(b"\x1b[1mX");
        let snapshot = emulator.snapshot();
        let cell = &snapshot.lines[0][0];
        assert_eq!(cell.c, "X");
        assert_ne!(cell.flags & flag_bits::BOLD, 0);
    }

    #[test]
    fn sgr_truecolor_foreground_is_rgb() {
        let mut emulator = Emulator::new(20, 5);
        // ESC[38;2;10;20;30m -> 24-bit fg.
        emulator.advance(b"\x1b[38;2;10;20;30mZ");
        let snapshot = emulator.snapshot();
        match &snapshot.lines[0][0].fg {
            WireColor::Rgb([r, g, b]) => assert_eq!((*r, *g, *b), (10, 20, 30)),
            other => panic!("expected rgb fg, got {other:?}"),
        }
    }

    #[test]
    fn resize_changes_reported_dimensions() {
        let mut emulator = Emulator::new(20, 5);
        emulator.resize(40, 10);
        let snapshot = emulator.snapshot();
        assert_eq!(snapshot.cols, 40);
        assert_eq!(snapshot.rows, 10);
        assert_eq!(snapshot.lines.len(), 10);
    }

    #[test]
    fn snapshot_serializes_to_json() {
        let mut emulator = Emulator::new(4, 2);
        emulator.advance(b"hi");
        let json = serde_json::to_string(&emulator.snapshot()).expect("serialize");
        assert!(json.contains("\"cols\":4"));
        assert!(json.contains("\"cursor\""));
    }
}
