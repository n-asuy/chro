import { describe, expect, it } from "vitest";
import { evaluateFilter, executeView, filterRows, sortRows } from "../engine";
import type {
  LensFilter,
  LensProperty,
  LensRow,
  LensSort,
  LensView,
} from "../types";

// Helper to create a row
const row = (filePath: string, values: Record<string, unknown>): LensRow => ({
  filePath,
  displayName: filePath.split("/").pop()?.replace(".md", "") ?? filePath,
  values,
});

// Test property definitions
const properties: Record<string, LensProperty> = {
  p_title: { key: "title", type: "text" },
  p_status: {
    key: "status",
    type: "select",
    options: ["todo", "doing", "done"],
  },
  p_priority: { key: "priority", type: "number" },
  p_done: { key: "done", type: "checkbox" },
  p_due: { key: "due", type: "date" },
  p_tags: { key: "tags", type: "multi_select" },
  p_url: { key: "url", type: "url" },
  p_file_name: { key: "file.name", type: "text" },
  p_file_path: { key: "file.path", type: "text" },
  p_file_folder: { key: "file.folder", type: "text" },
  p_file_mtime: { key: "file.mtime", type: "date" },
};

describe("evaluateFilter", () => {
  const testRow = row("test.md", {
    title: "Test Task",
    status: "doing",
    priority: 2,
    done: false,
    due: "2026-03-01",
    tags: ["urgent", "frontend"],
    url: "https://example.com",
  });

  describe("equality operators", () => {
    it("= matches equal values", () => {
      const filter: LensFilter = {
        property: "p_status",
        op: "=",
        value: "doing",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("= rejects non-equal values", () => {
      const filter: LensFilter = {
        property: "p_status",
        op: "=",
        value: "done",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(false);
    });

    it("!= matches non-equal values", () => {
      const filter: LensFilter = {
        property: "p_status",
        op: "!=",
        value: "done",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });
  });

  describe("comparison operators", () => {
    it("> works with numbers", () => {
      const filter: LensFilter = { property: "p_priority", op: ">", value: 1 };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("< works with numbers", () => {
      const filter: LensFilter = { property: "p_priority", op: "<", value: 5 };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it(">= works with numbers", () => {
      const filter: LensFilter = { property: "p_priority", op: ">=", value: 2 };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("<= works with numbers", () => {
      const filter: LensFilter = { property: "p_priority", op: "<=", value: 2 };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });
  });

  describe("string operators", () => {
    it("contains matches substring", () => {
      const filter: LensFilter = {
        property: "p_title",
        op: "contains",
        value: "Test",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("contains is case-insensitive", () => {
      const filter: LensFilter = {
        property: "p_title",
        op: "contains",
        value: "test",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("not_contains rejects substring", () => {
      const filter: LensFilter = {
        property: "p_title",
        op: "not_contains",
        value: "Test",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(false);
    });

    it("starts_with matches prefix", () => {
      const filter: LensFilter = {
        property: "p_title",
        op: "starts_with",
        value: "Test",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("ends_with matches suffix", () => {
      const filter: LensFilter = {
        property: "p_title",
        op: "ends_with",
        value: "Task",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("supports file.* built-in fields", () => {
      const fileRow = row("tasks/Test Task.md", {
        title: "Test Task",
      });
      const fileNameFilter: LensFilter = {
        property: "p_file_name",
        op: "contains",
        value: "Test",
      };
      const folderFilter: LensFilter = {
        property: "p_file_folder",
        op: "=",
        value: "tasks",
      };
      const pathFilter: LensFilter = {
        property: "p_file_path",
        op: "starts_with",
        value: "tasks/",
      };
      expect(evaluateFilter(fileRow, fileNameFilter, properties)).toBe(true);
      expect(evaluateFilter(fileRow, folderFilter, properties)).toBe(true);
      expect(evaluateFilter(fileRow, pathFilter, properties)).toBe(true);
    });
  });

  describe("empty operators", () => {
    it("is_empty for null value", () => {
      const r = row("test.md", {});
      const filter: LensFilter = { property: "p_title", op: "is_empty" };
      expect(evaluateFilter(r, filter, properties)).toBe(true);
    });

    it("is_not_empty for present value", () => {
      const filter: LensFilter = { property: "p_title", op: "is_not_empty" };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("is_empty for empty array", () => {
      const r = row("test.md", { tags: [] });
      const filter: LensFilter = { property: "p_tags", op: "is_empty" };
      expect(evaluateFilter(r, filter, properties)).toBe(true);
    });
  });

  describe("multi_select contains", () => {
    it("contains checks array items", () => {
      const filter: LensFilter = {
        property: "p_tags",
        op: "contains",
        value: "urgent",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("contains rejects missing array items", () => {
      const filter: LensFilter = {
        property: "p_tags",
        op: "contains",
        value: "backend",
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(false);
    });
  });

  describe("compound filters", () => {
    it("and requires all conditions", () => {
      const filter: LensFilter = {
        and: [
          { property: "p_status", op: "=", value: "doing" },
          { property: "p_priority", op: ">", value: 1 },
        ],
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("and fails if any condition fails", () => {
      const filter: LensFilter = {
        and: [
          { property: "p_status", op: "=", value: "doing" },
          { property: "p_priority", op: ">", value: 5 },
        ],
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(false);
    });

    it("or requires any condition", () => {
      const filter: LensFilter = {
        or: [
          { property: "p_status", op: "=", value: "done" },
          { property: "p_priority", op: "=", value: 2 },
        ],
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("not negates condition", () => {
      const filter: LensFilter = {
        not: { property: "p_status", op: "=", value: "done" },
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });

    it("nested compound filters", () => {
      const filter: LensFilter = {
        and: [
          {
            or: [
              { property: "p_status", op: "=", value: "doing" },
              { property: "p_status", op: "=", value: "done" },
            ],
          },
          { not: { property: "p_done", op: "=", value: true } },
        ],
      };
      expect(evaluateFilter(testRow, filter, properties)).toBe(true);
    });
  });
});

describe("sortRows", () => {
  const rows = [
    row("c.md", { title: "Charlie", priority: 3 }),
    row("a.md", { title: "Alpha", priority: 1 }),
    row("b.md", { title: "Bravo", priority: 2 }),
  ];

  it("sorts ascending by text", () => {
    const sorted = sortRows(rows, [{ by: "p_title", dir: "asc" }], properties);
    expect(sorted.map((r) => r.values.title)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("sorts descending by text", () => {
    const sorted = sortRows(rows, [{ by: "p_title", dir: "desc" }], properties);
    expect(sorted.map((r) => r.values.title)).toEqual([
      "Charlie",
      "Bravo",
      "Alpha",
    ]);
  });

  it("sorts by number", () => {
    const sorted = sortRows(
      rows,
      [{ by: "p_priority", dir: "asc" }],
      properties,
    );
    expect(sorted.map((r) => r.values.priority)).toEqual([1, 2, 3]);
  });

  it("handles null values (sorted first in asc)", () => {
    const withNull = [...rows, row("d.md", { title: "Delta" })];
    const sorted = sortRows(
      withNull,
      [{ by: "p_priority", dir: "asc" }],
      properties,
    );
    expect(sorted[0].filePath).toBe("d.md");
  });

  it("multi-key sort", () => {
    const data = [
      row("1.md", { status: "doing", priority: 2 }),
      row("2.md", { status: "done", priority: 1 }),
      row("3.md", { status: "doing", priority: 1 }),
    ];
    const sorted = sortRows(
      data,
      [
        { by: "p_status", dir: "asc" },
        { by: "p_priority", dir: "asc" },
      ],
      properties,
    );
    expect(sorted.map((r) => r.filePath)).toEqual(["3.md", "1.md", "2.md"]);
  });
});

describe("executeView", () => {
  const data = [
    row("1.md", { title: "Task 1", status: "todo", priority: 3 }),
    row("2.md", { title: "Task 2", status: "doing", priority: 1 }),
    row("3.md", { title: "Task 3", status: "done", priority: 2 }),
    row("4.md", { title: "Task 4", status: "doing", priority: 4 }),
  ];

  const baseView: LensView = {
    id: "v_table",
    name: "Table",
    type: "table",
    table: { columns: ["p_title", "p_status", "p_priority"] },
  };

  it("returns all rows with no filters", () => {
    const result = executeView(data, baseView, properties);
    expect(result.rows).toHaveLength(4);
    expect(result.totalCount).toBe(4);
  });

  it("applies view filters", () => {
    const view: LensView = {
      ...baseView,
      filters: [{ property: "p_status", op: "=", value: "doing" }],
    };
    const result = executeView(data, view, properties);
    expect(result.rows).toHaveLength(2);
    expect(result.totalCount).toBe(2);
  });

  it("applies global filters AND view filters", () => {
    const view: LensView = {
      ...baseView,
      filters: [{ property: "p_status", op: "=", value: "doing" }],
    };
    const globalFilters: LensFilter[] = [
      { property: "p_priority", op: ">", value: 2 },
    ];
    const result = executeView(data, view, properties, globalFilters);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].filePath).toBe("4.md");
  });

  it("applies sort", () => {
    const view: LensView = {
      ...baseView,
      sort: [{ by: "p_priority", dir: "asc" }],
    };
    const result = executeView(data, view, properties);
    expect(result.rows.map((r) => r.values.priority)).toEqual([1, 2, 3, 4]);
  });

  it("applies limit", () => {
    const view: LensView = {
      ...baseView,
      sort: [{ by: "p_priority", dir: "asc" }],
      limit: 2,
    };
    const result = executeView(data, view, properties);
    expect(result.rows).toHaveLength(2);
    expect(result.totalCount).toBe(4);
  });
});
