import { describe, expect, it } from "vitest";
import {
  addColumn,
  addRow,
  createEmptyCsv,
  deleteColumn,
  deleteRow,
  delimiterForExtension,
  parseCsv,
  serializeCsv,
  setCell,
  writeBlock,
} from "../csv";

describe("csv", () => {
  describe("parseCsv", () => {
    it("parses a simple comma-separated grid", () => {
      const data = parseCsv("a,b,c\n1,2,3");
      expect(data.rows).toEqual([
        ["a", "b", "c"],
        ["1", "2", "3"],
      ]);
      expect(data.columnCount).toBe(3);
      expect(data.delimiter).toBe(",");
      expect(data.eol).toBe("\n");
      expect(data.trailingNewline).toBe(false);
    });

    it("unquotes fields that contain the delimiter", () => {
      const data = parseCsv('name,note\n"Smith, John",hi');
      expect(data.rows[1]).toEqual(["Smith, John", "hi"]);
    });

    it("unescapes doubled quotes inside a quoted field", () => {
      const data = parseCsv('a\n"He said ""hi"""');
      expect(data.rows[1]).toEqual(['He said "hi"']);
    });

    it("keeps newlines that live inside a quoted field", () => {
      const data = parseCsv('a\n"line1\nline2"');
      expect(data.rows[1]).toEqual(["line1\nline2"]);
    });

    it("detects CRLF line endings and a trailing newline", () => {
      const data = parseCsv("a,b\r\n1,2\r\n");
      expect(data.rows).toEqual([
        ["a", "b"],
        ["1", "2"],
      ]);
      expect(data.eol).toBe("\r\n");
      expect(data.trailingNewline).toBe(true);
    });

    it("strips a leading byte order mark", () => {
      const data = parseCsv("﻿a,b\n1,2");
      expect(data.rows[0]).toEqual(["a", "b"]);
    });

    it("pads ragged rows to the widest row", () => {
      const data = parseCsv("a,b,c\n1,2");
      expect(data.columnCount).toBe(3);
      expect(data.rows[1]).toEqual(["1", "2", ""]);
    });

    it("represents an empty document as a single empty cell", () => {
      const data = parseCsv("");
      expect(data.rows).toEqual([[""]]);
      expect(data.columnCount).toBe(1);
    });

    it("parses tab-separated values when given a tab delimiter", () => {
      const data = parseCsv("a\tb\n1\t2", "\t");
      expect(data.rows).toEqual([
        ["a", "b"],
        ["1", "2"],
      ]);
      expect(data.delimiter).toBe("\t");
    });
  });

  describe("serializeCsv round-trips", () => {
    const cases: Array<[string, string, "," | "\t"]> = [
      ["plain", "a,b,c\n1,2,3", ","],
      ["quoted delimiter", 'name,note\n"Smith, John",hi', ","],
      ["escaped quotes", 'a\n"He said ""hi"""', ","],
      ["embedded newline", 'a\n"line1\nline2"', ","],
      ["crlf with trailing", "a,b\r\n1,2\r\n", ","],
      ["trailing newline", "a,b\n1,2\n", ","],
      ["tab separated", "a\tb\n1\t2", "\t"],
    ];

    for (const [label, text, delimiter] of cases) {
      it(`round-trips ${label} exactly`, () => {
        expect(serializeCsv(parseCsv(text, delimiter))).toBe(text);
      });
    }

    it("quotes only fields that need quoting", () => {
      const data = parseCsv("a,b,c\n1,2,3");
      const next = setCell(setCell(data, 1, 0, "x,y"), 1, 1, 'q"q');
      expect(serializeCsv(next)).toBe('a,b,c\n"x,y","q""q",3');
    });

    it("serializes an empty document to an empty string", () => {
      expect(serializeCsv(parseCsv(""))).toBe("");
    });
  });

  describe("mutations are immutable", () => {
    it("setCell updates one cell without mutating the source", () => {
      const data = parseCsv("a,b\n1,2");
      const next = setCell(data, 1, 1, "9");
      expect(next.rows[1][1]).toBe("9");
      expect(data.rows[1][1]).toBe("2");
    });

    it("addRow appends an empty row of the right width", () => {
      const data = parseCsv("a,b,c\n1,2,3");
      const next = addRow(data);
      expect(next.rows).toHaveLength(3);
      expect(next.rows[2]).toEqual(["", "", ""]);
    });

    it("addRow inserts at a given index", () => {
      const data = parseCsv("a,b\n1,2");
      const next = addRow(data, 1);
      expect(next.rows).toEqual([
        ["a", "b"],
        ["", ""],
        ["1", "2"],
      ]);
    });

    it("addColumn appends a cell to every row", () => {
      const data = parseCsv("a,b\n1,2");
      const next = addColumn(data);
      expect(next.columnCount).toBe(3);
      expect(next.rows).toEqual([
        ["a", "b", ""],
        ["1", "2", ""],
      ]);
    });

    it("deleteRow removes the row and is a no-op out of range", () => {
      const data = parseCsv("a,b\n1,2\n3,4");
      expect(deleteRow(data, 1).rows).toEqual([
        ["a", "b"],
        ["3", "4"],
      ]);
      expect(deleteRow(data, 9).rows).toEqual(data.rows);
    });

    it("deleteColumn removes the column from every row", () => {
      const data = parseCsv("a,b,c\n1,2,3");
      const next = deleteColumn(data, 1);
      expect(next.columnCount).toBe(2);
      expect(next.rows).toEqual([
        ["a", "c"],
        ["1", "3"],
      ]);
    });
  });

  describe("helpers", () => {
    it("maps extensions to a delimiter", () => {
      expect(delimiterForExtension("csv")).toBe(",");
      expect(delimiterForExtension("CSV")).toBe(",");
      expect(delimiterForExtension("tsv")).toBe("\t");
      expect(delimiterForExtension(null)).toBe(",");
    });

    it("creates an editable empty document", () => {
      const data = createEmptyCsv();
      expect(data.rows).toEqual([[""]]);
      expect(serializeCsv(data)).toBe("");
    });
  });

  describe("writeBlock (paste)", () => {
    it("overlays a block within the existing bounds", () => {
      const data = parseCsv("a,b\n1,2");
      const next = writeBlock(data, 0, 0, [["X"]]);
      expect(next.rows).toEqual([
        ["X", "b"],
        ["1", "2"],
      ]);
      expect(next.columnCount).toBe(2);
    });

    it("grows rows when the block extends past the last row", () => {
      const data = parseCsv("a,b\n1,2");
      const next = writeBlock(data, 3, 0, [["z"]]);
      expect(next.rows).toEqual([
        ["a", "b"],
        ["1", "2"],
        ["", ""],
        ["z", ""],
      ]);
    });

    it("grows columns and pads every row when the block is wider", () => {
      const data = parseCsv("a\n1");
      const next = writeBlock(data, 0, 0, [
        ["x", "y"],
        ["p", "q"],
      ]);
      expect(next.columnCount).toBe(2);
      expect(next.rows).toEqual([
        ["x", "y"],
        ["p", "q"],
      ]);
    });

    it("pastes a multi-cell block at an offset, expanding the sheet", () => {
      const data = parseCsv("a,b\n1,2");
      const next = writeBlock(data, 0, 2, [["c"], ["3"]]);
      expect(next.columnCount).toBe(3);
      expect(next.rows).toEqual([
        ["a", "b", "c"],
        ["1", "2", "3"],
      ]);
    });
  });
});
