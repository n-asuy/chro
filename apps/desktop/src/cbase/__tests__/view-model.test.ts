import { describe, expect, it } from "vitest";
import type { CbaseProperty, CbaseView } from "../types";
import { resolveTableColumns } from "../view-model";

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
