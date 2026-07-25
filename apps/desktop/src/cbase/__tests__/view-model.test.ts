import { describe, expect, it } from "vitest";
import type { CbaseProperty, CbaseRow, CbaseView } from "../types";
import {
  applyOverlay,
  createDatasetPathFilter,
  datasetFolder,
  deriveSelectOptions,
  formatDateLabel,
  isEditableProperty,
  moveCellFocus,
  newNoteContent,
  nextUntitledPath,
  overlayKey,
  resolveTableColumns,
  settleOverlay,
  toDateInputValue,
} from "../view-model";

describe("createDatasetPathFilter", () => {
  it("matches common recursive include and exclude globs", () => {
    const matches = createDatasetPathFilter({
      include: ["tasks/**/*.md"],
      exclude: ["tasks/archive/**"],
    });
    expect(matches("tasks/today.md")).toBe(true);
    expect(matches("tasks/nested/tomorrow.md")).toBe(true);
    expect(matches("tasks/archive/old.md")).toBe(false);
    expect(matches("notes/other.md")).toBe(false);
    expect(matches("tasks/image.png")).toBe(false);
  });

  it("falls back to match-all for unsupported include syntax", () => {
    const matches = createDatasetPathFilter({
      include: ["{tasks,notes}/**/*.md"],
    });
    expect(matches("anything.bin")).toBe(true);
  });
});

const properties: Record<string, CbaseProperty> = {
  p_title: { key: "title", type: "text", label: "Title" },
  p_priority: { key: "priority", type: "number" },
};

describe("resolveTableColumns", () => {
  it("uses explicit table columns with labels and widths", () => {
    const view: CbaseView = {
      id: "v",
      name: "V",
      type: "table",
      table: {
        columns: ["p_title", "p_priority"],
        column_widths: { p_title: 320 },
      },
    };

    expect(resolveTableColumns(view, properties)).toEqual([
      { propertyId: "p_title", label: "Title", type: "text", width: 320 },
      {
        propertyId: "p_priority",
        label: "priority",
        type: "number",
        width: undefined,
      },
    ]);
  });

  it("falls back to all properties when columns are omitted", () => {
    const view: CbaseView = {
      id: "v",
      name: "V",
      type: "table",
    };

    expect(
      resolveTableColumns(view, properties).map((col) => col.propertyId),
    ).toEqual(["p_title", "p_priority"]);
  });
});

const row = (
  filePath: string,
  values: Record<string, unknown> = {},
): CbaseRow => ({
  filePath,
  displayName: filePath.split("/").pop()?.replace(/\.md$/, "") ?? filePath,
  values,
});

describe("optimistic overlay", () => {
  it("applies pending values only to the matching row", () => {
    const rows = [
      row("tasks/a.md", { status: "todo" }),
      row("tasks/b.md", { status: "todo" }),
    ];
    const overlay = { [overlayKey("tasks/a.md", "status")]: "doing" };

    const overlaid = applyOverlay(rows, overlay);
    expect(overlaid[0].values.status).toBe("doing");
    expect(overlaid[1].values.status).toBe("todo");
    expect(overlaid[1]).toBe(rows[1]);
  });

  it("handles paths containing spaces and null removals", () => {
    const rows = [row("notes/with space.md", { done: true })];
    const overlay = { [overlayKey("notes/with space.md", "done")]: null };

    expect(applyOverlay(rows, overlay)[0].values.done).toBeUndefined();
  });

  it("settles entries the fresh document reflects, keeps stale ones", () => {
    const overlay = {
      [overlayKey("a.md", "status")]: "doing",
      [overlayKey("b.md", "status")]: "done",
      [overlayKey("gone.md", "status")]: "done",
    };
    const rows = [
      row("a.md", { status: "doing" }), // settled: written value visible
      row("b.md", { status: "todo" }), // stale: refresh raced the write
    ];

    const settled = settleOverlay(rows, overlay);
    expect(Object.keys(settled)).toEqual([overlayKey("b.md", "status")]);
  });
});

describe("cell helpers", () => {
  it("formats date labels compactly, with year only when it differs", () => {
    const today = new Date("2026-07-20T00:00:00Z");
    expect(formatDateLabel("2026-07-22", today)).toBe("Jul 22");
    expect(formatDateLabel("2025-01-05", today)).toBe("Jan 5, 2025");
    expect(formatDateLabel("not a date", today)).toBeNull();
    expect(formatDateLabel(42, today)).toBeNull();
  });

  it("normalizes date values for date inputs", () => {
    expect(toDateInputValue("2026-07-05")).toBe("2026-07-05");
    expect(toDateInputValue("garbage")).toBe("");
  });

  it("derives select options from declarations plus used values", () => {
    const property: CbaseProperty = {
      key: "status",
      type: "select",
      options: ["todo", "doing"],
    };
    const rows = [
      row("a.md", { status: "done" }),
      row("b.md", { status: "todo" }),
    ];
    expect(deriveSelectOptions(property, rows)).toEqual([
      "todo",
      "doing",
      "done",
    ]);
  });

  it("treats file.* properties as read-only", () => {
    expect(isEditableProperty({ key: "file.name", type: "text" })).toBe(false);
    expect(isEditableProperty({ key: "status", type: "select" })).toBe(true);
    expect(isEditableProperty(undefined)).toBe(false);
  });

  it("moves cell focus with arrows and wraps Tab to the next row", () => {
    expect(moveCellFocus({ row: 1, col: 1 }, "ArrowUp", 3, 3)).toEqual({
      row: 0,
      col: 1,
    });
    expect(moveCellFocus({ row: 0, col: 0 }, "ArrowLeft", 3, 3)).toEqual({
      row: 0,
      col: 0,
    });
    expect(moveCellFocus({ row: 0, col: 2 }, "Tab", 3, 3)).toEqual({
      row: 1,
      col: 0,
    });
    expect(moveCellFocus({ row: 0, col: 0 }, "a", 3, 3)).toBeNull();
  });
});

describe("new note helpers", () => {
  it("derives the dataset folder from the first include glob", () => {
    expect(datasetFolder({ include: ["tasks/**/*.md"] })).toBe("tasks");
    expect(datasetFolder({ include: ["a/b/*.md"] })).toBe("a/b");
    expect(datasetFolder({ include: ["**/*.md"] })).toBe("");
    expect(datasetFolder(undefined)).toBe("");
  });

  it("picks the first untitled path not taken", () => {
    expect(nextUntitledPath("tasks", [])).toBe("tasks/untitled.md");
    expect(
      nextUntitledPath("tasks", ["tasks/untitled.md", "tasks/untitled-1.md"]),
    ).toBe("tasks/untitled-2.md");
    expect(nextUntitledPath("", [])).toBe("untitled.md");
  });

  it("builds frontmatter for visible editable properties only", () => {
    const view: CbaseView = {
      id: "v",
      name: "V",
      type: "table",
      table: { columns: ["p_name", "p_status", "p_priority"] },
    };
    const props: Record<string, CbaseProperty> = {
      p_name: { key: "file.name", type: "text" },
      p_status: { key: "status", type: "select" },
      p_priority: { key: "priority", type: "number" },
    };
    expect(newNoteContent(view, props)).toBe("---\nstatus:\npriority:\n---\n");
  });
});
