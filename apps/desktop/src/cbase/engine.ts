/**
 * .cbase filter and sort engine
 * Evaluates filter expressions against indexed rows and produces sorted results.
 */

import { buildLensQuery } from "./query";
import {
  comparePropertyValues,
  isEmptyValue,
  resolvePropertyValue,
} from "./runtime";
import type {
  LensFilter,
  LensFilterCondition,
  LensProperty,
  LensRow,
  LensSort,
  LensView,
  LensViewResult,
} from "./types";

function evaluateCondition(
  row: LensRow,
  condition: LensFilterCondition,
  properties: Record<string, LensProperty>,
): boolean {
  const value = resolvePropertyValue(row, condition.property, properties);
  const target = condition.value;

  switch (condition.op) {
    case "is_empty":
      return isEmptyValue(value);
    case "is_not_empty":
      return !isEmptyValue(value);
    case "=":
      return comparePropertyValues(value, target) === 0;
    case "!=":
      return comparePropertyValues(value, target) !== 0;
    case "<":
      return comparePropertyValues(value, target) < 0;
    case ">":
      return comparePropertyValues(value, target) > 0;
    case "<=":
      return comparePropertyValues(value, target) <= 0;
    case ">=":
      return comparePropertyValues(value, target) >= 0;
    case "contains": {
      const search = String(target ?? "").toLowerCase();
      if (Array.isArray(value)) {
        return value.some((item) =>
          String(item ?? "")
            .toLowerCase()
            .includes(search),
        );
      }
      return String(value ?? "")
        .toLowerCase()
        .includes(search);
    }
    case "not_contains": {
      const search = String(target ?? "").toLowerCase();
      if (Array.isArray(value)) {
        return !value.some((item) =>
          String(item ?? "")
            .toLowerCase()
            .includes(search),
        );
      }
      return !String(value ?? "")
        .toLowerCase()
        .includes(search);
    }
    case "starts_with":
      return String(value ?? "")
        .toLowerCase()
        .startsWith(String(target ?? "").toLowerCase());
    case "ends_with":
      return String(value ?? "")
        .toLowerCase()
        .endsWith(String(target ?? "").toLowerCase());
    default:
      return true;
  }
}

/**
 * Evaluate a filter expression recursively (and/or/not + leaf conditions).
 */
export function evaluateFilter(
  row: LensRow,
  filter: LensFilter,
  properties: Record<string, LensProperty>,
): boolean {
  if ("and" in filter) {
    return filter.and.every((f) => evaluateFilter(row, f, properties));
  }
  if ("or" in filter) {
    return filter.or.some((f) => evaluateFilter(row, f, properties));
  }
  if ("not" in filter) {
    return !evaluateFilter(row, filter.not, properties);
  }
  return evaluateCondition(row, filter, properties);
}

/**
 * Apply filters to rows.
 * Multiple filters at the same level are AND-combined.
 */
export function filterRows(
  rows: LensRow[],
  filters: LensFilter[],
  properties: Record<string, LensProperty>,
): LensRow[] {
  if (filters.length === 0) return rows;
  return rows.filter((row) =>
    filters.every((filter) => evaluateFilter(row, filter, properties)),
  );
}

/**
 * Sort rows by the given sort specifications.
 */
export function sortRows(
  rows: LensRow[],
  sortSpecs: LensSort[],
  properties: Record<string, LensProperty>,
): LensRow[] {
  if (sortSpecs.length === 0) return rows;

  return [...rows].sort((a, b) => {
    for (const spec of sortSpecs) {
      const aVal = resolvePropertyValue(a, spec.by, properties);
      const bVal = resolvePropertyValue(b, spec.by, properties);
      const cmp = comparePropertyValues(aVal, bVal);
      if (cmp !== 0) {
        return spec.dir === "desc" ? -cmp : cmp;
      }
    }
    return a.filePath.localeCompare(b.filePath);
  });
}

/**
 * Execute a lens view against indexed rows.
 * Applies global filters, view filters, sort, and limit.
 */
export function executeView(
  rows: LensRow[],
  view: LensView,
  properties: Record<string, LensProperty>,
  globalFilters?: LensFilter[],
  globalSort?: LensSort[],
): LensViewResult {
  const query = buildLensQuery(view, globalFilters, globalSort);
  let result = rows;
  let totalCount = result.length;

  for (const operation of query.operations) {
    if (operation.type === "where") {
      result = filterRows(result, operation.filters, properties);
      totalCount = result.length;
      continue;
    }

    if (operation.type === "sort") {
      result = sortRows(result, operation.sort, properties);
      continue;
    }

    if (operation.type === "limit") {
      totalCount = result.length;
      result = result.slice(0, operation.limit);
    }
  }

  return { view: query.view, rows: result, totalCount };
}
