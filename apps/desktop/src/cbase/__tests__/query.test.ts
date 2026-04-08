import { describe, expect, it } from "vitest";
import { buildCbaseQuery } from "../query";
import type { CbaseFilter, CbaseSort, CbaseView } from "../types";

describe("buildCbaseQuery", () => {
  const baseView: CbaseView = {
    id: "v_table",
    name: "Table",
    type: "table",
    table: { columns: ["p_title"] },
  };

  it("builds query with header/source/operations", () => {
    const globalFilters: CbaseFilter[] = [
      { property: "p_status", op: "=", value: "todo" },
    ];
    const globalSort: CbaseSort[] = [{ by: "p_priority", dir: "desc" }];

    const query = buildCbaseQuery(baseView, globalFilters, globalSort);

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
    const globalSort: CbaseSort[] = [{ by: "p_priority", dir: "desc" }];
    const viewSort: CbaseSort[] = [{ by: "p_title", dir: "asc" }];

    const view: CbaseView = {
      ...baseView,
      sort: viewSort,
      limit: 5,
    };

    const query = buildCbaseQuery(view, undefined, globalSort);

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
    const globalFilters: CbaseFilter[] = [
      { property: "p_status", op: "=", value: "todo" },
    ];
    const viewFilters: CbaseFilter[] = [
      { property: "p_priority", op: ">", value: 1 },
    ];

    const view: CbaseView = {
      ...baseView,
      filters: viewFilters,
    };

    const query = buildCbaseQuery(view, globalFilters);

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
