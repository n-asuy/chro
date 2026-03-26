import { describe, expect, it } from "vitest";
import { buildLensQuery } from "../query";
import type { LensFilter, LensSort, LensView } from "../types";

describe("buildLensQuery", () => {
  const baseView: LensView = {
    id: "v_table",
    name: "Table",
    type: "table",
    table: { columns: ["p_title"] },
  };

  it("builds query with header/source/operations", () => {
    const globalFilters: LensFilter[] = [
      { property: "p_status", op: "=", value: "todo" },
    ];
    const globalSort: LensSort[] = [{ by: "p_priority", dir: "desc" }];

    const query = buildLensQuery(baseView, globalFilters, globalSort);

    expect(query.header).toEqual({
      type: "table",
      viewId: "v_table",
      viewName: "Table",
    });
    expect(query.source).toEqual({ type: "indexed_rows" });
    expect(query.operations).toEqual([
      {
        type: "where",
        filters: globalFilters,
        scope: "global",
      },
      {
        type: "sort",
        sort: globalSort,
        scope: "global",
      },
    ]);
  });

  it("uses view sort over global sort, then applies limit", () => {
    const globalSort: LensSort[] = [{ by: "p_priority", dir: "desc" }];
    const viewSort: LensSort[] = [{ by: "p_title", dir: "asc" }];

    const view: LensView = {
      ...baseView,
      sort: viewSort,
      limit: 5,
    };

    const query = buildLensQuery(view, undefined, globalSort);

    expect(query.operations).toEqual([
      {
        type: "sort",
        sort: viewSort,
        scope: "view",
      },
      {
        type: "limit",
        limit: 5,
      },
    ]);
  });

  it("includes global and view filters in order", () => {
    const globalFilters: LensFilter[] = [
      { property: "p_status", op: "=", value: "todo" },
    ];
    const viewFilters: LensFilter[] = [
      { property: "p_priority", op: ">", value: 1 },
    ];

    const view: LensView = {
      ...baseView,
      filters: viewFilters,
    };

    const query = buildLensQuery(view, globalFilters);

    expect(query.operations).toEqual([
      {
        type: "where",
        filters: globalFilters,
        scope: "global",
      },
      {
        type: "where",
        filters: viewFilters,
        scope: "view",
      },
    ]);
  });
});
