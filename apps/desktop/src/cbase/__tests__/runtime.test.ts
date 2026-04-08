import { describe, expect, it } from "vitest";
import {
  comparePropertyValues,
  formatPropertyValue,
  getColumnLabel,
  isEmptyValue,
  resolvePropertyValue,
} from "../runtime";
import type { CbaseProperty, CbaseRow } from "../types";

const properties: Record<string, CbaseProperty> = {
  p_title: { key: "title", type: "text" },
  p_file_name: { key: "file.name", type: "text" },
  p_file_path: { key: "file.path", type: "text" },
  p_file_folder: { key: "file.folder", type: "text" },
  p_file_mtime: { key: "file.mtime", type: "date" },
  p_file_ext: { key: "file.ext", type: "text" },
  p_done: { key: "done", type: "checkbox", label: "Done" },
};

const row: CbaseRow = {
  filePath: "tasks/today.md",
  displayName: "today",
  modifiedAt: "2026-03-18T12:00:00.000Z",
  values: {
    title: "Today",
    done: false,
  },
};

describe("resolvePropertyValue", () => {
  it("resolves frontmatter values", () => {
    expect(resolvePropertyValue(row, "p_title", properties)).toBe("Today");
  });

  it("resolves file.* built-ins", () => {
    expect(resolvePropertyValue(row, "p_file_name", properties)).toBe("today");
    expect(resolvePropertyValue(row, "p_file_path", properties)).toBe(
      "tasks/today.md",
    );
    expect(resolvePropertyValue(row, "p_file_folder", properties)).toBe(
      "tasks",
    );
    expect(resolvePropertyValue(row, "p_file_mtime", properties)).toBe(
      "2026-03-18T12:00:00.000Z",
    );
    expect(resolvePropertyValue(row, "p_file_ext", properties)).toBe("md");
  });
});

describe("runtime helpers", () => {
  it("checks empty values", () => {
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue("")).toBe(true);
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue("x")).toBe(false);
  });

  it("compares values with empty first", () => {
    expect(comparePropertyValues(undefined, "a")).toBeLessThan(0);
    expect(comparePropertyValues(2, 1)).toBeGreaterThan(0);
    expect(comparePropertyValues("a", "b")).toBeLessThan(0);
  });

  it("formats values for table cells", () => {
    expect(formatPropertyValue(undefined)).toBe("—");
    expect(formatPropertyValue(false)).toBe("false");
    expect(formatPropertyValue(["a", "b"])).toBe("a, b");
  });

  it("returns column labels with fallback", () => {
    expect(getColumnLabel("p_done", properties)).toBe("Done");
    expect(getColumnLabel("p_title", properties)).toBe("title");
    expect(getColumnLabel("unknown", properties)).toBe("unknown");
  });
});
