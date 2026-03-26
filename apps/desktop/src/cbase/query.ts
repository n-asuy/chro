import type { LensFilter, LensSort, LensView } from "./types";

export type LensQueryType = "table";

export interface LensQueryHeader {
  type: LensQueryType;
  viewId: string;
  viewName: string;
}

export interface LensQuerySource {
  type: "indexed_rows";
}

export interface LensWhereOperation {
  type: "where";
  filters: LensFilter[];
  scope: "global" | "view";
}

export interface LensSortOperation {
  type: "sort";
  sort: LensSort[];
  scope: "global" | "view";
}

export interface LensLimitOperation {
  type: "limit";
  limit: number;
}

export type LensQueryOperation =
  | LensWhereOperation
  | LensSortOperation
  | LensLimitOperation;

export interface LensQuery {
  header: LensQueryHeader;
  source: LensQuerySource;
  operations: LensQueryOperation[];
  view: LensView;
}

/**
 * Build a query-plan execution model from a lens view.
 * This keeps cbase YAML syntax while aligning internals with
 * header/source/operations structure.
 */
export function buildLensQuery(
  view: LensView,
  globalFilters?: LensFilter[],
  globalSort?: LensSort[],
): LensQuery {
  const operations: LensQueryOperation[] = [];

  if (globalFilters && globalFilters.length > 0) {
    operations.push({
      type: "where",
      filters: globalFilters,
      scope: "global",
    });
  }

  if (view.filters && view.filters.length > 0) {
    operations.push({
      type: "where",
      filters: view.filters,
      scope: "view",
    });
  }

  if (view.sort && view.sort.length > 0) {
    operations.push({
      type: "sort",
      sort: view.sort,
      scope: "view",
    });
  } else if (globalSort && globalSort.length > 0) {
    operations.push({
      type: "sort",
      sort: globalSort,
      scope: "global",
    });
  }

  if (view.limit != null && view.limit > 0) {
    operations.push({
      type: "limit",
      limit: view.limit,
    });
  }

  return {
    header: {
      type: view.type,
      viewId: view.id,
      viewName: view.name,
    },
    source: {
      type: "indexed_rows",
    },
    operations,
    view,
  };
}
