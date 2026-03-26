/**
 * Pure functions for markdown table structural mutations.
 *
 * Each function takes a TableInfo (with absolute document positions) and returns
 * ChangeSpec[] that can be passed directly to `view.dispatch({ changes })`.
 * No DOM, no EditorView, no side effects — easily testable.
 *
 * Row operations use "visual row index" where the delimiter row is skipped:
 *   0 = header row, 1 = first body row, 2 = second body row, etc.
 */

import type { ChangeSpec } from "@codemirror/state";
import type { TableCell, TableInfo, TableRow } from "./table-types";
import { splitTableRowCells } from "./table-cell-utils";

// ─── Helpers ──────────────────────────────────────────────────────────

function parseAlignment(cell: string): "left" | "center" | "right" | undefined {
  const trimmed = cell.trim();
  const hasLeft = trimmed.startsWith(":");
  const hasRight = trimmed.endsWith(":");
  if (hasLeft && hasRight) return "center";
  if (hasRight) return "right";
  if (hasLeft) return "left";
  return undefined;
}

/** Get visible (non-delimiter) rows: [header, body0, body1, ...]. */
function visibleRows(table: TableInfo): TableRow[] {
  return table.rows.filter((r) => !r.isDelimiter);
}

/** Get body (non-header, non-delimiter) rows only. */
function bodyRows(table: TableInfo): TableRow[] {
  return table.rows.filter((r) => !r.isHeader && !r.isDelimiter);
}

/** Get the delimiter row (if any). */
function delimiterRow(table: TableInfo): TableRow | undefined {
  return table.rows.find((r) => r.isDelimiter);
}

/** Build an empty row markdown string matching column count. */
function emptyRowMarkdown(colCount: number): string {
  const cells = Array(colCount).fill("  ");
  return `| ${cells.join(" | ")} |`;
}

/** Build a delimiter cell string for a given alignment. */
function delimiterCellContent(align?: "left" | "center" | "right"): string {
  switch (align) {
    case "left":
      return " :--- ";
    case "center":
      return " :---: ";
    case "right":
      return " ---: ";
    default:
      return " --- ";
  }
}

// ─── Row operations ───────────────────────────────────────────────────

/**
 * Insert an empty row above the row at `visualRowIndex`.
 * Index 0 = header row (insertion goes after delimiter).
 */
export function insertRowAbove(
  table: TableInfo,
  visualRowIndex: number,
): ChangeSpec[] {
  const rows = visibleRows(table);
  const row = rows[visualRowIndex];
  if (!row) return [];

  const colCount = row.cells.length;

  // Cannot insert above header; insert after delimiter instead
  if (row.isHeader) {
    const delim = delimiterRow(table);
    const insertPos = delim ? delim.to : row.to;
    return [{ from: insertPos, insert: `\n${emptyRowMarkdown(colCount)}` }];
  }

  return [{ from: row.from, insert: `${emptyRowMarkdown(colCount)}\n` }];
}

/**
 * Insert an empty row below the row at `visualRowIndex`.
 * Index 0 = header row (insertion goes after delimiter).
 */
export function insertRowBelow(
  table: TableInfo,
  visualRowIndex: number,
): ChangeSpec[] {
  const rows = visibleRows(table);
  const row = rows[visualRowIndex];
  if (!row) return [];

  const colCount = row.cells.length;

  // If header, insert after delimiter
  if (row.isHeader) {
    const delim = delimiterRow(table);
    const insertPos = delim ? delim.to : row.to;
    return [{ from: insertPos, insert: `\n${emptyRowMarkdown(colCount)}` }];
  }

  return [{ from: row.to, insert: `\n${emptyRowMarkdown(colCount)}` }];
}

/**
 * Delete the row at `visualRowIndex`.
 * Returns null if it's a header row or the last remaining body row.
 */
export function deleteRow(
  table: TableInfo,
  visualRowIndex: number,
): ChangeSpec[] | null {
  const rows = visibleRows(table);
  const row = rows[visualRowIndex];
  if (!row) return null;

  // Cannot delete header rows
  if (row.isHeader) return null;

  // Cannot delete the last body row
  const body = bodyRows(table);
  if (body.length <= 1) return null;

  // Delete the row including the preceding newline
  const allRows = table.rows;
  const actualIdx = allRows.indexOf(row);

  if (actualIdx > 0) {
    const prevRow = allRows[actualIdx - 1];
    return [{ from: prevRow.to, to: row.to, insert: "" }];
  }

  // Fallback: delete row + following newline
  if (actualIdx < allRows.length - 1) {
    const nextRow = allRows[actualIdx + 1];
    return [{ from: row.from, to: nextRow.from, insert: "" }];
  }

  return [{ from: row.from, to: row.to, insert: "" }];
}

// ─── Column operations ────────────────────────────────────────────────

/**
 * Insert an empty column to the left of `colIndex`.
 *
 * Inserts ` content |` before each cell's content start position.
 * For `| A | B |`, inserting left of col 1 at cell[1].from:
 *   `| A |` + `  |` + ` B |` → `| A |  | B |`
 */
export function insertColumnLeft(
  table: TableInfo,
  colIndex: number,
): ChangeSpec[] {
  const changes: ChangeSpec[] = [];

  for (let i = table.rows.length - 1; i >= 0; i--) {
    const row = table.rows[i];
    const cell = row.cells[colIndex];
    if (!cell) continue;

    const insertContent = row.isDelimiter ? " --- |" : "  |";
    changes.push({ from: cell.from, to: cell.from, insert: insertContent });
  }

  return changes;
}

/**
 * Insert an empty column to the right of `colIndex`.
 *
 * Inserts `|  ` (pipe + content) at each cell's content end position.
 * For `| A | B |`, cell[0].to = position of the `|` after ` A `.
 * Inserting `|  ` at cell[0].to → `| A |  | B |`.
 */
export function insertColumnRight(
  table: TableInfo,
  colIndex: number,
): ChangeSpec[] {
  const changes: ChangeSpec[] = [];

  for (let i = table.rows.length - 1; i >= 0; i--) {
    const row = table.rows[i];
    const cell = row.cells[colIndex];
    if (!cell) continue;

    // cell.to is the end of cell content; the pipe separator follows at cell.to.
    // Insert a new pipe + empty content before that separator pipe.
    const insertContent = row.isDelimiter ? "| --- " : "|  ";
    changes.push({ from: cell.to, to: cell.to, insert: insertContent });
  }

  return changes;
}

/**
 * Delete the column at `colIndex`.
 * Returns null for single-column tables.
 */
export function deleteColumn(
  table: TableInfo,
  colIndex: number,
): ChangeSpec[] | null {
  const colCount = table.rows[0]?.cells.length ?? 0;
  if (colCount <= 1) return null;

  const changes: ChangeSpec[] = [];

  for (let i = table.rows.length - 1; i >= 0; i--) {
    const row = table.rows[i];
    const cell = row.cells[colIndex];
    if (!cell) continue;

    if (colIndex === 0) {
      // First column: remove from cell.from to next cell's from
      const nextCell = row.cells[colIndex + 1];
      if (nextCell) {
        changes.push({ from: cell.from, to: nextCell.from, insert: "" });
      }
    } else {
      // Non-first column: remove from prev cell's to (the pipe) through this cell's to
      const prevCell = row.cells[colIndex - 1];
      if (prevCell) {
        changes.push({ from: prevCell.to, to: cell.to, insert: "" });
      }
    }
  }

  return changes;
}

// ─── Append operations ────────────────────────────────────────────────

export function appendRow(table: TableInfo): ChangeSpec[] {
  const colCount = table.rows[0]?.cells.length ?? 0;
  if (colCount === 0) return [];
  return [{ from: table.to, insert: `\n${emptyRowMarkdown(colCount)}` }];
}

export function appendColumn(table: TableInfo): ChangeSpec[] {
  const colCount = table.rows[0]?.cells.length ?? 0;
  if (colCount === 0) return [];
  return insertColumnRight(table, colCount - 1);
}

// ─── Alignment ────────────────────────────────────────────────────────

export function setColumnAlignment(
  table: TableInfo,
  colIndex: number,
  align: "left" | "center" | "right",
): ChangeSpec[] {
  const delim = delimiterRow(table);
  if (!delim) return [];

  const cell = delim.cells[colIndex];
  if (!cell) return [];

  const newContent = delimiterCellContent(align);
  return [{ from: cell.from, to: cell.to, insert: newContent }];
}

// ─── Standalone parser (for testing without CodeMirror) ───────────────

/**
 * Parse a markdown table string into a TableInfo structure.
 * Used for testing without CodeMirror's syntax tree.
 */
export function parseTableFromMarkdown(
  markdown: string,
  baseOffset: number,
): TableInfo {
  const lines = markdown.split("\n");
  const rows: TableRow[] = [];
  let alignments: ("left" | "center" | "right" | undefined)[] = [];
  let headerFound = false;
  let delimiterFound = false;
  let currentOffset = baseOffset;

  for (const line of lines) {
    const isHeader = !headerFound && !delimiterFound;
    const cells: TableCell[] = splitTableRowCells(line, currentOffset).map(
      (cell) => ({
        ...cell,
        isHeader,
      }),
    );

    const isDelimiter = /^[\s|:\-]+$/.test(line) && line.includes("-");

    if (isDelimiter && !delimiterFound) {
      delimiterFound = true;
      alignments = cells.map((c) => parseAlignment(c.content));
    }

    rows.push({
      cells,
      from: currentOffset,
      to: currentOffset + line.length,
      isHeader: isHeader && !isDelimiter,
      isDelimiter,
    });

    if (isHeader && !isDelimiter) {
      headerFound = true;
    }

    currentOffset += line.length + 1;
  }

  return {
    rows,
    from: baseOffset,
    to: baseOffset + markdown.length,
    alignments,
  };
}
