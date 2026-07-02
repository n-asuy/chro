/**
 * Delimiter-separated values: a small, dependency-free RFC 4180 parser and
 * serializer plus immutable grid mutations.
 *
 * The model keeps the line ending, trailing newline, and delimiter that were
 * detected on parse so an untouched file round-trips byte-for-byte. Editing
 * normalizes ragged rows to a rectangle; that is the only intentional rewrite.
 */

export type CsvDelimiter = "," | "\t";

export interface CsvData {
  /** Rectangular grid of cells. Row 0 is treated as the header by the editor. */
  rows: string[][];
  /** Width every row is padded to (always >= 1). */
  columnCount: number;
  delimiter: CsvDelimiter;
  /** Line ending reproduced on serialize. */
  eol: "\n" | "\r\n";
  /** Whether the source ended with a line ending. */
  trailingNewline: boolean;
}

const BOM = "﻿";

export const delimiterForExtension = (
  extension?: string | null,
): CsvDelimiter => (extension?.toLowerCase() === "tsv" ? "\t" : ",");

export const createEmptyCsv = (delimiter: CsvDelimiter = ","): CsvData => ({
  rows: [[""]],
  columnCount: 1,
  delimiter,
  eol: "\n",
  trailingNewline: false,
});

export const parseCsv = (
  input: string,
  delimiter: CsvDelimiter = ",",
): CsvData => {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");

  if (text === "") return createEmptyCsv(delimiter);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += ch;
    }
  }

  // Flush the final record unless it is only the artifact of a trailing newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const columnCount = Math.max(1, ...rows.map((r) => r.length));
  const padded = rows.map((r) =>
    r.length === columnCount
      ? r
      : [...r, ...Array(columnCount - r.length).fill("")],
  );

  return { rows: padded, columnCount, delimiter, eol, trailingNewline };
};

const needsQuoting = (field: string, delimiter: CsvDelimiter): boolean =>
  field.includes(delimiter) ||
  field.includes('"') ||
  field.includes("\n") ||
  field.includes("\r");

const encodeField = (field: string, delimiter: CsvDelimiter): string =>
  needsQuoting(field, delimiter) ? `"${field.replace(/"/g, '""')}"` : field;

export const serializeCsv = (data: CsvData): string => {
  const body = data.rows
    .map((row) =>
      row.map((cell) => encodeField(cell, data.delimiter)).join(data.delimiter),
    )
    .join(data.eol);
  return data.trailingNewline ? body + data.eol : body;
};

export const setCell = (
  data: CsvData,
  rowIndex: number,
  columnIndex: number,
  value: string,
): CsvData => {
  if (!data.rows[rowIndex] || columnIndex >= data.columnCount) return data;
  const rows = data.rows.map((row, r) =>
    r === rowIndex
      ? row.map((cell, c) => (c === columnIndex ? value : cell))
      : row,
  );
  return { ...data, rows };
};

export const addRow = (data: CsvData, atIndex?: number): CsvData => {
  const at = atIndex ?? data.rows.length;
  const empty = Array<string>(data.columnCount).fill("");
  const rows = [...data.rows.slice(0, at), empty, ...data.rows.slice(at)];
  return { ...data, rows };
};

export const addColumn = (data: CsvData, atIndex?: number): CsvData => {
  const at = atIndex ?? data.columnCount;
  const rows = data.rows.map((row) => [
    ...row.slice(0, at),
    "",
    ...row.slice(at),
  ]);
  return { ...data, rows, columnCount: data.columnCount + 1 };
};

export const deleteRow = (data: CsvData, rowIndex: number): CsvData => {
  if (!data.rows[rowIndex]) return data;
  const rows = data.rows.filter((_, r) => r !== rowIndex);
  if (rows.length === 0) return createEmptyCsv(data.delimiter);
  return { ...data, rows };
};

export const deleteColumn = (data: CsvData, columnIndex: number): CsvData => {
  if (columnIndex < 0 || columnIndex >= data.columnCount) return data;
  if (data.columnCount === 1) return createEmptyCsv(data.delimiter);
  const rows = data.rows.map((row) => row.filter((_, c) => c !== columnIndex));
  return { ...data, rows, columnCount: data.columnCount - 1 };
};

/**
 * Overlay a 2D block of cells at (atRow, atCol), growing the grid with empty
 * cells when the block extends past the current bounds. This is the paste
 * primitive: clipboard data dropped at the active cell expands the sheet.
 */
export const writeBlock = (
  data: CsvData,
  atRow: number,
  atCol: number,
  block: string[][],
): CsvData => {
  if (block.length === 0) return data;
  const blockWidth = Math.max(0, ...block.map((row) => row.length));
  const columnCount = Math.max(data.columnCount, atCol + blockWidth);
  const rowCount = Math.max(data.rows.length, atRow + block.length);

  const rows: string[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const source = data.rows[r] ?? [];
    const row = Array.from({ length: columnCount }, (_, c) => source[c] ?? "");
    rows.push(row);
  }
  block.forEach((blockRow, i) => {
    blockRow.forEach((value, j) => {
      rows[atRow + i][atCol + j] = value;
    });
  });

  return { ...data, rows, columnCount };
};
