import { describe, expect, it } from "vitest";

import {
  type CellSnapshot,
  type TerminalSnapshot,
  cellCharAt,
  selectionToText,
  wordRange,
} from "../canvas-terminal";

// A width-1 cell unless `width` says otherwise. Wide glyphs are followed by a
// width-0 spacer in the snapshot, exactly as the Rust emulator emits them.
const cell = (c: string, width = 1): CellSnapshot => ({
  c,
  fg: "fg",
  bg: "bg",
  flags: 0,
  width,
});

/** Build a row of `cols` columns, right-padded with blank cells. */
const row = (cells: CellSnapshot[], cols: number): CellSnapshot[] => {
  const used = cells.reduce(
    (n, cur) => n + (cur.width === 0 ? 0 : cur.width),
    0,
  );
  const padded = [...cells];
  for (let i = used; i < cols; i++) padded.push(cell(" "));
  return padded;
};

const snapshot = (lines: CellSnapshot[][], cols: number): TerminalSnapshot => ({
  cols,
  rows: lines.length,
  cursor: { line: 0, col: 0, shape: "block", visible: true },
  lines,
  app_cursor_keys: false,
  bracketed_paste: false,
});

describe("cellCharAt", () => {
  // "hi界x": 界 is a wide glyph occupying columns 2 and 3.
  const line = row(
    [cell("h"), cell("i"), cell("界", 2), cell("", 0), cell("x")],
    10,
  );

  it("maps narrow cells to their column", () => {
    expect(cellCharAt(line, 0)).toBe("h");
    expect(cellCharAt(line, 1)).toBe("i");
    expect(cellCharAt(line, 4)).toBe("x");
  });

  it("answers for both columns a wide glyph occupies", () => {
    expect(cellCharAt(line, 2)).toBe("界");
    expect(cellCharAt(line, 3)).toBe("界");
  });

  it("returns empty string past the row's content", () => {
    expect(cellCharAt(line, 9)).toBe(" "); // padded blank
    expect(cellCharAt(line, 99)).toBe("");
  });
});

describe("selectionToText", () => {
  const line0 = row(
    [cell("h"), cell("i"), cell("界", 2), cell("", 0), cell("x")],
    10,
  );
  const line1 = row(
    [cell("l"), cell("s"), cell(" "), cell("-"), cell("l")],
    10,
  );
  const snap = snapshot([line0, line1], 10);

  it("trims trailing blank padding from a full row", () => {
    expect(selectionToText(snap, { row: 0, col: 0 }, { row: 0, col: 9 })).toBe(
      "hi界x",
    );
  });

  it("extracts a partial single-row range", () => {
    expect(selectionToText(snap, { row: 0, col: 1 }, { row: 0, col: 4 })).toBe(
      "i界x",
    );
  });

  it("includes a wide glyph selected from its trailing column", () => {
    expect(selectionToText(snap, { row: 0, col: 3 }, { row: 0, col: 4 })).toBe(
      "界x",
    );
  });

  it("joins a multi-row selection with newlines", () => {
    expect(selectionToText(snap, { row: 0, col: 2 }, { row: 1, col: 4 })).toBe(
      "界x\nls -l",
    );
  });

  it("normalizes a reversed (bottom-up) drag", () => {
    expect(selectionToText(snap, { row: 1, col: 4 }, { row: 0, col: 2 })).toBe(
      "界x\nls -l",
    );
  });

  it("preserves interior spaces but trims the line end", () => {
    expect(selectionToText(snap, { row: 1, col: 0 }, { row: 1, col: 9 })).toBe(
      "ls -l",
    );
  });

  it("returns empty string for a collapsed selection", () => {
    expect(selectionToText(snap, { row: 0, col: 3 }, { row: 0, col: 3 })).toBe(
      "",
    );
  });

  it("keeps blank middle lines as empty rows", () => {
    const blank = row([], 10);
    const tri = snapshot([line1, blank, line1], 10);
    expect(selectionToText(tri, { row: 0, col: 0 }, { row: 2, col: 9 })).toBe(
      "ls -l\n\nls -l",
    );
  });
});

describe("wordRange", () => {
  // "ls -la /tmp" laid out across columns.
  const line = row(
    "ls -la /tmp".split("").map((ch) => cell(ch)),
    20,
  );

  it("expands to the surrounding non-whitespace run", () => {
    expect(wordRange(line, 20, 0)).toEqual([0, 1]); // "ls"
    expect(wordRange(line, 20, 4)).toEqual([3, 5]); // "-la"
    expect(wordRange(line, 20, 9)).toEqual([7, 10]); // "/tmp"
  });

  it("does not cross a whitespace boundary", () => {
    expect(wordRange(line, 20, 2)).toEqual([2, 2]); // the space itself
  });

  it("stops at the grid edge", () => {
    const word = row(
      "abc".split("").map((ch) => cell(ch)),
      3,
    );
    expect(wordRange(word, 3, 1)).toEqual([0, 2]);
  });
});
