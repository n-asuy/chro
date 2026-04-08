import type { CbaseFilter, CbaseSort, CbaseView } from "./types";

export type CbaseQueryType = "table";

export interface CbaseQueryHeader {
  type: CbaseQueryType;
  viewId: string;
  viewName: string;
}

export interface CbaseQuerySource {
  type: "indexed_rows";
}

export interface CbaseWhereOperation {
  type: "where";
  filters: CbaseFilter[];
  scope: "global" | "view";
}

export interface CbaseSortOperation {
  type: "sort";
  sort: CbaseSort[];
  scope: "global" | "view";
}

export interface CbaseLimitOperation {
  type: "limit";
  limit: number;
}

export type CbaseQueryOperation =
  | CbaseWhereOperation
  | CbaseSortOperation
  | CbaseLimitOperation;

export interface CbaseQuery {
  header: CbaseQueryHeader;
  source: CbaseQuerySource;
  operations: CbaseQueryOperation[];
  view: CbaseView;
}

/**
 * Build a query-plan execution model from a cbase view.
 * This keeps cbase YAML syntax while aligning internals with
 * header/source/operations structure.
 */
export function buildCbaseQuery(
  view: CbaseView,
  globalFilters?: CbaseFilter[],
  globalSort?: CbaseSort[],
): CbaseQuery {
  const operations: CbaseQueryOperation[] = [];

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
