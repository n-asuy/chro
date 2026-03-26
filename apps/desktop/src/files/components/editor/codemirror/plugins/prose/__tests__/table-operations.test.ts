import type { ChangeSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  appendColumn,
  appendRow,
  deleteColumn,
  deleteRow,
  insertColumnLeft,
  insertColumnRight,
  insertRowAbove,
  insertRowBelow,
  parseTableFromMarkdown,
  setColumnAlignment,
} from "../table-operations";

/**
 * Apply ChangeSpec[] to a source string and return the result.
 * Changes are sorted in reverse document order to preserve positions.
 */
function applyChanges(source: string, changes: ChangeSpec[]): string {
  const sorted = (changes as { from: number; to?: number; insert?: string }[])
    .slice()
    .sort((a, b) => b.from - a.from);

  let result = source;
  for (const c of sorted) {
    const from = c.from;
    const to = c.to ?? c.from;
    const insert = c.insert ?? "";
    result = result.slice(0, from) + insert + result.slice(to);
  }
  return result;
}

// Visual row indices: 0=header, 1=first body, 2=second body, ...

const BASIC_TABLE = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`;

const SINGLE_ROW_TABLE = `| Name | Age |
| --- | --- |
| Alice | 30 |`;

const SINGLE_COL_TABLE = `| Name |
| --- |
| Alice |
| Bob |`;

const ALIGNED_TABLE = `| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |`;

const TABLE_WITH_EMPTY_ROW = `| Name | Age |
| --- | --- |
| Alice | 30 |
|  |  |`;

const TABLE_WITH_ESCAPED_PIPE = `| A \\| B | C |
| --- | --- |
| x | y |`;

const TABLE_WITH_ESCAPED_PIPE_WIKILINK = `| Link |
| --- |
| [[My note\\|Display name]] |`;

const TABLE_WITH_UNESCAPED_PIPE_WIKILINK = `| Link |
| --- |
| [[My note|Display name]] |`;

describe("parseTableFromMarkdown", () => {
  it("parses a basic table", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    expect(table.rows).toHaveLength(4);
    expect(table.rows[0].isHeader).toBe(true);
    expect(table.rows[1].isDelimiter).toBe(true);
    expect(table.rows[2].isHeader).toBe(false);
    expect(table.rows[2].isDelimiter).toBe(false);
    expect(table.rows[0].cells).toHaveLength(2);
    expect(table.rows[0].cells[0].content).toBe(" Name ");
    expect(table.rows[0].cells[1].content).toBe(" Age ");
  });

  it("parses with a base offset", () => {
    const offset = 100;
    const table = parseTableFromMarkdown(BASIC_TABLE, offset);
    expect(table.from).toBe(offset);
    expect(table.rows[0].from).toBe(offset);
    expect(table.rows[0].cells[0].from).toBe(offset + 1);
  });

  it("parses alignments from delimiter row", () => {
    const table = parseTableFromMarkdown(ALIGNED_TABLE, 0);
    expect(table.alignments).toEqual(["left", "center", "right"]);
  });

  it("treats a row with only empty/whitespace cells as a body row, not delimiter", () => {
    const table = parseTableFromMarkdown(TABLE_WITH_EMPTY_ROW, 0);
    expect(table.rows).toHaveLength(4);
    const lastRow = table.rows[3];
    expect(lastRow.isDelimiter).toBe(false);
    expect(lastRow.isHeader).toBe(false);
    expect(lastRow.cells).toHaveLength(2);
  });

  it("treats escaped pipes as cell content, not separators", () => {
    const table = parseTableFromMarkdown(TABLE_WITH_ESCAPED_PIPE, 0);
    expect(table.rows[0].cells).toHaveLength(2);
    expect(table.rows[0].cells[0].content.trim()).toBe("A \\| B");
    expect(table.rows[0].cells[1].content.trim()).toBe("C");
  });

  it("keeps escaped-pipe wikilinks inside a single cell", () => {
    const table = parseTableFromMarkdown(TABLE_WITH_ESCAPED_PIPE_WIKILINK, 0);
    expect(table.rows[2].cells).toHaveLength(1);
    expect(table.rows[2].cells[0].content.trim()).toBe(
      "[[My note\\|Display name]]",
    );
  });

  it("keeps unescaped-pipe wikilinks inside a single cell", () => {
    const table = parseTableFromMarkdown(TABLE_WITH_UNESCAPED_PIPE_WIKILINK, 0);
    expect(table.rows[2].cells).toHaveLength(1);
    expect(table.rows[2].cells[0].content.trim()).toBe(
      "[[My note|Display name]]",
    );
  });
});

describe("insertRowAbove", () => {
  it("inserts above header → goes after delimiter", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    // visualIndex 0 = header; cannot insert above header, so inserts after delimiter
    const changes = insertRowAbove(table, 0);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toMatch(/^\|.*\|.*\|$/); // new empty row after delimiter
    expect(lines[3]).toBe("| Alice | 30 |");
  });

  it("inserts above first body row", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    // visualIndex 1 = first body row (Alice)
    const changes = insertRowAbove(table, 1);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toMatch(/^\|.*\|.*\|$/); // new empty row
    expect(lines[3]).toBe("| Alice | 30 |"); // Alice pushed down
  });

  it("inserts above a middle body row", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    // visualIndex 2 = second body row (Bob)
    const changes = insertRowAbove(table, 2);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[3]).toMatch(/^\|.*\|.*\|$/); // new empty row before Bob
    expect(lines[4]).toBe("| Bob | 25 |");
  });
});

describe("insertRowBelow", () => {
  it("inserts below first body row", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    // visualIndex 1 = first body row (Alice)
    const changes = insertRowBelow(table, 1);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe("| Alice | 30 |");
    expect(lines[3]).toMatch(/^\|.*\|.*\|$/); // new empty row
    expect(lines[4]).toBe("| Bob | 25 |");
  });

  it("inserts below the last body row", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    // visualIndex 2 = last body row (Bob)
    const changes = insertRowBelow(table, 2);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe("| Bob | 25 |");
    expect(lines[4]).toMatch(/^\|.*\|.*\|$/); // new empty row at end
  });
});

describe("deleteRow", () => {
  it("deletes first body row", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    // visualIndex 1 = first body row (Alice)
    const changes = deleteRow(table, 1);
    expect(changes).not.toBeNull();
    const result = applyChanges(BASIC_TABLE, changes!);
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("| Bob | 25 |");
  });

  it("deletes the last body row when multiple exist", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    // visualIndex 2 = second body row (Bob)
    const changes = deleteRow(table, 2);
    expect(changes).not.toBeNull();
    const result = applyChanges(BASIC_TABLE, changes!);
    const lines = result.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("| Alice | 30 |");
  });

  it("returns null when trying to delete header", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = deleteRow(table, 0);
    expect(changes).toBeNull();
  });

  it("returns null for single data row table", () => {
    const table = parseTableFromMarkdown(SINGLE_ROW_TABLE, 0);
    // visualIndex 1 = only body row
    const changes = deleteRow(table, 1);
    expect(changes).toBeNull();
  });
});

describe("insertColumnLeft", () => {
  it("inserts a column at the beginning", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = insertColumnLeft(table, 0);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    for (const line of lines) {
      const cells = line.split("|").filter((s) => s !== "");
      expect(cells.length).toBeGreaterThanOrEqual(3);
    }
    expect(lines[0]).toContain("Name");
    expect(lines[0]).toContain("Age");
  });

  it("inserts a column in the middle", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = insertColumnLeft(table, 1);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    const headerCells = lines[0]
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(headerCells[0]).toBe("Name");
    expect(headerCells[1]).toBe(""); // new empty column
    expect(headerCells[2]).toBe("Age");
  });
});

describe("insertColumnRight", () => {
  it("inserts a column after the last column", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = insertColumnRight(table, 1);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    const headerCells = lines[0]
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(headerCells[0]).toBe("Name");
    expect(headerCells[1]).toBe("Age");
    expect(headerCells[2]).toBe(""); // new column at end
  });

  it("inserts a column after the first column", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = insertColumnRight(table, 0);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    const headerCells = lines[0]
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(headerCells[0]).toBe("Name");
    expect(headerCells[1]).toBe(""); // new column
    expect(headerCells[2]).toBe("Age");
  });
});

describe("deleteColumn", () => {
  it("deletes the first column", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = deleteColumn(table, 0);
    expect(changes).not.toBeNull();
    const result = applyChanges(BASIC_TABLE, changes!);
    const lines = result.split("\n");
    const headerCells = lines[0]
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(headerCells).toHaveLength(1);
    expect(headerCells[0]).toBe("Age");
  });

  it("deletes the last column", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = deleteColumn(table, 1);
    expect(changes).not.toBeNull();
    const result = applyChanges(BASIC_TABLE, changes!);
    const lines = result.split("\n");
    const headerCells = lines[0]
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(headerCells).toHaveLength(1);
    expect(headerCells[0]).toBe("Name");
  });

  it("returns null for single column table", () => {
    const table = parseTableFromMarkdown(SINGLE_COL_TABLE, 0);
    const changes = deleteColumn(table, 0);
    expect(changes).toBeNull();
  });
});

describe("appendRow", () => {
  it("appends a row at the end", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = appendRow(table);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toMatch(/^\|.*\|.*\|$/);
    const newCells = lines[4]
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(newCells).toHaveLength(2);
  });
});

describe("appendColumn", () => {
  it("appends a column to all rows", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = appendColumn(table);
    const result = applyChanges(BASIC_TABLE, changes);
    const lines = result.split("\n");
    for (const line of lines) {
      const cells = line
        .split("|")
        .filter((s) => s !== "")
        .map((s) => s.trim());
      expect(cells.length).toBeGreaterThanOrEqual(3);
    }
    expect(lines[1]).toContain("---"); // delimiter has new column
  });
});

describe("setColumnAlignment", () => {
  it("sets left alignment", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = setColumnAlignment(table, 0, "left");
    const result = applyChanges(BASIC_TABLE, changes);
    const delimiterLine = result.split("\n")[1];
    const cells = delimiterLine
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(cells[0]).toMatch(/^:-+$/);
  });

  it("sets center alignment", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = setColumnAlignment(table, 0, "center");
    const result = applyChanges(BASIC_TABLE, changes);
    const delimiterLine = result.split("\n")[1];
    const cells = delimiterLine
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(cells[0]).toMatch(/^:-+:$/);
  });

  it("sets right alignment", () => {
    const table = parseTableFromMarkdown(BASIC_TABLE, 0);
    const changes = setColumnAlignment(table, 1, "right");
    const result = applyChanges(BASIC_TABLE, changes);
    const delimiterLine = result.split("\n")[1];
    const cells = delimiterLine
      .split("|")
      .filter((s) => s !== "")
      .map((s) => s.trim());
    expect(cells[1]).toMatch(/^-+:$/);
  });
});

describe("operations with offset", () => {
  it("works correctly when table starts at non-zero offset", () => {
    const prefix = "# Title\n\nSome text\n\n";
    const full = prefix + BASIC_TABLE;
    const table = parseTableFromMarkdown(BASIC_TABLE, prefix.length);
    // visualIndex 1 = first body row
    const changes = insertRowBelow(table, 1);
    const result = applyChanges(full, changes);
    expect(result.startsWith(prefix)).toBe(true);
    const tableLines = result.slice(prefix.length).split("\n");
    expect(tableLines).toHaveLength(5);
  });
});
