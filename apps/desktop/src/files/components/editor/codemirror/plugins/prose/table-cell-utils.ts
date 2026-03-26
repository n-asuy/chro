/**
 * Utilities for parsing and normalizing markdown table cell content.
 */

interface TableCellSlice {
  content: string;
  from: number;
  to: number;
}

/**
 * Returns true when the character at `index` is escaped by an odd number
 * of preceding backslashes.
 */
export function isEscapedAt(text: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

/**
 * Split a markdown table row into cells using only unescaped `|` separators
 * that are outside Obsidian-style wikilinks (`[[...]]`).
 * Leading/trailing separators are treated as row boundaries, not empty cells.
 */
export function splitTableRowCells(
  rowText: string,
  rowFrom: number,
): TableCellSlice[] {
  const separators: number[] = [];
  let wikilinkDepth = 0;

  for (let i = 0; i < rowText.length; i++) {
    if (
      rowText[i] === "[" &&
      rowText[i + 1] === "[" &&
      !isEscapedAt(rowText, i)
    ) {
      wikilinkDepth += 1;
      i += 1;
      continue;
    }

    if (
      rowText[i] === "]" &&
      rowText[i + 1] === "]" &&
      !isEscapedAt(rowText, i)
    ) {
      wikilinkDepth = Math.max(0, wikilinkDepth - 1);
      i += 1;
      continue;
    }

    if (
      rowText[i] === "|" &&
      !isEscapedAt(rowText, i) &&
      wikilinkDepth === 0
    ) {
      separators.push(i);
    }
  }

  if (separators.length === 0) {
    return [
      {
        content: rowText,
        from: rowFrom,
        to: rowFrom + rowText.length,
      },
    ];
  }

  const cells: TableCellSlice[] = [];
  let cellStart = separators[0] === 0 ? 1 : 0;
  let separatorIndex = separators[0] === 0 ? 1 : 0;

  for (; separatorIndex < separators.length; separatorIndex++) {
    const separatorPos = separators[separatorIndex];
    if (separatorPos < cellStart) {
      continue;
    }
    cells.push({
      content: rowText.slice(cellStart, separatorPos),
      from: rowFrom + cellStart,
      to: rowFrom + separatorPos,
    });
    cellStart = separatorPos + 1;
  }

  const hasTrailingSeparator =
    separators[separators.length - 1] === rowText.length - 1;
  if (!hasTrailingSeparator && cellStart <= rowText.length) {
    cells.push({
      content: rowText.slice(cellStart),
      from: rowFrom + cellStart,
      to: rowFrom + rowText.length,
    });
  }

  return cells;
}

/**
 * Escape unescaped `|` so table cells remain structurally valid.
 */
export function escapeUnescapedTablePipes(value: string): string {
  let output = "";

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "|" && !isEscapedAt(value, i)) {
      output += "\\|";
      continue;
    }
    output += char;
  }

  return output;
}

/**
 * Convert markdown-escaped table pipes (`\|`) back to literal pipes.
 */
export function unescapeTableCellPipes(value: string): string {
  let output = "";

  for (let i = 0; i < value.length; i++) {
    if (
      value[i] === "\\" &&
      value[i + 1] === "|" &&
      !isEscapedAt(value, i)
    ) {
      output += "|";
      i += 1;
      continue;
    }
    output += value[i];
  }

  return output;
}
