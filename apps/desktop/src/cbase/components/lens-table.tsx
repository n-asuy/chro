/**
 * BaseTable - Obsidian style file database table.
 */

import { Badge } from "@chro/ui/badge";
import { Button } from "@chro/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Input } from "@chro/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@chro/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chro/ui/select";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Filter,
  Plus,
  X,
} from "lucide-react";
import { type FC, useEffect, useMemo, useRef, useState } from "react";
import {
  comparePropertyValues,
  formatPropertyValue,
  resolvePropertyValue,
} from "../runtime";
import type {
  FilterOperator,
  LensFilter,
  LensFilterCondition,
  LensProperty,
  LensRow,
  LensView,
} from "../types";
import { resolveTableColumns } from "../view-model";

interface BaseTableProps {
  rows: LensRow[];
  totalCount: number;
  view: LensView;
  properties: Record<string, LensProperty>;
  definedFilters?: LensFilter[];
  viewFilters?: LensFilter[];
  onViewFiltersChange?: (filters: LensFilter[]) => void;
  onRowClick?: (filePath: string) => void;
  onColumnsChange?: (columnIds: string[]) => void;
  onSortChange?: (sortKey: string | null, direction: SortDirection) => void;
  onColumnWidthsChange?: (columnWidths: Record<string, number>) => void;
}

type SortDirection = "asc" | "desc";
type FilterDraft = {
  propertyId: string;
  operator: FilterOperator;
  value: string;
};

type ColumnOption = {
  propertyId: string;
  label: string;
  type: LensProperty["type"];
  width: number | undefined;
};

const QUERY_ORDER_SORT_KEY = "__query_order__";
const DEFAULT_COLUMN_WIDTH = 180;
const MIN_COLUMN_WIDTH = 96;
const FILTER_OPS_WITHOUT_VALUE: FilterOperator[] = ["is_empty", "is_not_empty"];
const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  "=": "is",
  "!=": "is not",
  "<": "is less than",
  ">": "is greater than",
  "<=": "is at most",
  ">=": "is at least",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

function createDraft(): FilterDraft {
  return { propertyId: "", operator: "contains", value: "" };
}

function getAllowedFilterOperators(property?: LensProperty): FilterOperator[] {
  if (!property) return ["contains", "is_empty", "is_not_empty"];

  if (property.type === "number" || property.type === "date") {
    return ["=", "!=", "<", ">", "<=", ">=", "is_empty", "is_not_empty"];
  }

  if (property.type === "checkbox" || property.type === "select") {
    return ["=", "!=", "is_empty", "is_not_empty"];
  }

  return [
    "=",
    "!=",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "is_empty",
    "is_not_empty",
  ];
}

function defaultFilterOperator(property?: LensProperty): FilterOperator {
  if (!property) return "contains";
  if (
    property.type === "number" ||
    property.type === "date" ||
    property.type === "checkbox" ||
    property.type === "select"
  ) {
    return "=";
  }
  return "contains";
}

function filterValueToString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "";
  return String(value);
}

function getSortDirectionLabels(
  property?: LensProperty,
): Record<SortDirection, string> {
  if (!property) {
    return { asc: "As returned", desc: "As returned" };
  }

  if (property.type === "date") {
    return { asc: "Old to new", desc: "New to old" };
  }
  if (property.type === "number") {
    return { asc: "Low to high", desc: "High to low" };
  }
  if (property.type === "checkbox") {
    return { asc: "False to true", desc: "True to false" };
  }

  return { asc: "A → Z", desc: "Z → A" };
}

function defaultSortDirection(property?: LensProperty): SortDirection {
  return property?.type === "date" ? "desc" : "asc";
}

function isConditionFilter(filter: LensFilter): filter is LensFilterCondition {
  return !("and" in filter) && !("or" in filter) && !("not" in filter);
}

function countFilterConditions(filter: LensFilter): number {
  if ("and" in filter) {
    return filter.and.reduce(
      (count, entry) => count + countFilterConditions(entry),
      0,
    );
  }
  if ("or" in filter) {
    return filter.or.reduce(
      (count, entry) => count + countFilterConditions(entry),
      0,
    );
  }
  if ("not" in filter) {
    return countFilterConditions(filter.not);
  }
  return 1;
}

function formatConditionSummary(
  filter: LensFilterCondition,
  properties: Record<string, LensProperty>,
): string {
  const property = properties[filter.property];
  const label = property?.label ?? property?.key ?? filter.property;
  const valueText = FILTER_OPS_WITHOUT_VALUE.includes(filter.op)
    ? ""
    : ` ${filterValueToString(filter.value)}`;
  return `${label} ${FILTER_OPERATOR_LABELS[filter.op]}${valueText}`;
}

function formatFilterSummary(
  filter: LensFilter,
  properties: Record<string, LensProperty>,
): string {
  if (isConditionFilter(filter)) {
    return formatConditionSummary(filter, properties);
  }
  if ("and" in filter) {
    return `All of: ${filter.and
      .map((entry) => formatFilterSummary(entry, properties))
      .join("; ")}`;
  }
  if ("or" in filter) {
    return `Any of: ${filter.or
      .map((entry) => formatFilterSummary(entry, properties))
      .join("; ")}`;
  }
  return `None of: ${formatFilterSummary(filter.not, properties)}`;
}

function createFilterEntries(filters: LensFilter[]) {
  const seen = new Map<string, number>();
  return filters.map((filter) => {
    const serialized = JSON.stringify(filter);
    const duplicateCount = seen.get(serialized) ?? 0;
    seen.set(serialized, duplicateCount + 1);

    return {
      filter,
      key:
        duplicateCount === 0 ? serialized : `${serialized}:${duplicateCount}`,
    };
  });
}

export const BaseTable: FC<BaseTableProps> = ({
  rows,
  totalCount,
  view,
  properties,
  definedFilters = [],
  viewFilters = [],
  onViewFiltersChange,
  onRowClick,
  onColumnsChange,
  onSortChange,
  onColumnWidthsChange,
}) => {
  const toolbarButtonClassName =
    "inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-custom-text-200 transition-colors hover:bg-custom-background-90 hover:text-custom-text-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-custom-primary-100";
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [draft, setDraft] = useState<FilterDraft>(createDraft());
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  const [sortKey, setSortKey] = useState<string>(QUERY_ORDER_SORT_KEY);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => view.table?.column_widths ?? {},
  );
  const [activeResizeColumnId, setActiveResizeColumnId] = useState<
    string | null
  >(null);
  const columnWidthsRef = useRef<Record<string, number>>(columnWidths);
  const resizeStateRef = useRef<{
    propertyId: string;
    startWidth: number;
    startX: number;
  } | null>(null);

  const baseColumns = useMemo(
    () => resolveTableColumns(view, properties),
    [view, properties],
  );
  const baseColumnIds = useMemo(
    () => baseColumns.map((column) => column.propertyId),
    [baseColumns],
  );
  const allColumns = useMemo(
    () =>
      Object.entries(properties)
        .map(([propertyId, property]) => ({
          propertyId,
          label: property.label ?? property.key ?? propertyId,
          type: property.type,
          width: view.table?.column_widths?.[propertyId],
        }))
        .sort((left, right) =>
          left.label.localeCompare(right.label, "ja", {
            numeric: true,
            sensitivity: "base",
          }),
        ),
    [properties, view.table?.column_widths],
  );
  const columnMap = useMemo(
    () =>
      Object.fromEntries(
        allColumns.map((column) => [column.propertyId, column] as const),
      ),
    [allColumns],
  );
  const [visibleColumnIds, setVisibleColumnIds] =
    useState<string[]>(baseColumnIds);

  useEffect(() => {
    setVisibleColumnIds(baseColumnIds);
  }, [baseColumnIds, view.id]);

  useEffect(() => {
    const nextWidths = view.table?.column_widths ?? {};
    columnWidthsRef.current = nextWidths;
    setColumnWidths(nextWidths);
  }, [view.id, view.table?.column_widths]);

  useEffect(() => {
    if (sortKey === QUERY_ORDER_SORT_KEY) return;
    const exists = allColumns.some((column) => column.propertyId === sortKey);
    if (!exists) {
      setSortKey(QUERY_ORDER_SORT_KEY);
      setSortDirection("asc");
    }
  }, [allColumns, sortKey]);

  useEffect(() => {
    const firstPropertyId = allColumns[0]?.propertyId ?? "";
    setDraft((current) => {
      const propertyId =
        current.propertyId && properties[current.propertyId]
          ? current.propertyId
          : firstPropertyId;
      const property = propertyId ? properties[propertyId] : undefined;
      const operator = getAllowedFilterOperators(property).includes(
        current.operator,
      )
        ? current.operator
        : defaultFilterOperator(property);
      const value =
        property?.type === "checkbox" &&
        current.value !== "true" &&
        current.value !== "false"
          ? ""
          : current.value;

      if (
        propertyId === current.propertyId &&
        operator === current.operator &&
        value === current.value
      ) {
        return current;
      }

      return { propertyId, operator, value };
    });
  }, [allColumns, properties]);

  const visibleColumns = useMemo(
    () =>
      visibleColumnIds
        .map((propertyId) => columnMap[propertyId])
        .filter((column): column is ColumnOption => Boolean(column)),
    [visibleColumnIds, columnMap],
  );
  const getColumnWidth = (column: ColumnOption) =>
    columnWidths[column.propertyId] ?? column.width ?? DEFAULT_COLUMN_WIDTH;
  const tableMinWidth = useMemo(
    () =>
      visibleColumns.reduce(
        (total, column) => total + getColumnWidth(column),
        0,
      ),
    [columnWidths, visibleColumns],
  );

  const activeSortProperty =
    sortKey === QUERY_ORDER_SORT_KEY ? undefined : properties[sortKey];
  const sortDirectionLabels = getSortDirectionLabels(activeSortProperty);
  const draftProperty = draft.propertyId
    ? properties[draft.propertyId]
    : undefined;
  const allowedDraftOperators = getAllowedFilterOperators(draftProperty);
  const requiresDraftValue = !FILTER_OPS_WITHOUT_VALUE.includes(draft.operator);

  const sortedRows = useMemo(() => {
    if (sortKey === QUERY_ORDER_SORT_KEY) {
      return rows;
    }

    const orderedRows = [...rows];
    orderedRows.sort((a, b) => {
      const aValue = resolvePropertyValue(a, sortKey, properties);
      const bValue = resolvePropertyValue(b, sortKey, properties);
      const diff = comparePropertyValues(aValue, bValue);
      if (diff !== 0) {
        return sortDirection === "asc" ? diff : -diff;
      }

      return a.filePath.localeCompare(b.filePath, "ja", {
        numeric: true,
        sensitivity: "base",
      });
    });
    return orderedRows;
  }, [rows, sortDirection, sortKey, properties]);

  const formattedCount = useMemo(
    () => new Intl.NumberFormat("en-US").format(totalCount),
    [totalCount],
  );

  const totalActiveFilterCount = useMemo(
    () =>
      definedFilters.reduce(
        (count, filter) => count + countFilterConditions(filter),
        0,
      ) +
      viewFilters.reduce(
        (count, filter) => count + countFilterConditions(filter),
        0,
      ),
    [definedFilters, viewFilters],
  );
  const definedFilterEntries = useMemo(
    () => createFilterEntries(definedFilters),
    [definedFilters],
  );

  const hiddenColumnOptions = useMemo(
    () =>
      allColumns.filter(
        (column) => !visibleColumnIds.includes(column.propertyId),
      ),
    [allColumns, visibleColumnIds],
  );

  const canAddFilter =
    Boolean(onViewFiltersChange) &&
    Boolean(draft.propertyId) &&
    (!requiresDraftValue ||
      (draftProperty?.type === "checkbox"
        ? draft.value === "true" || draft.value === "false"
        : draft.value.trim().length > 0));

  const updateDraft = (nextDraft: Partial<FilterDraft>) => {
    setDraft((current) => ({ ...current, ...nextDraft }));
  };

  const handleAddFilter = () => {
    if (!onViewFiltersChange || !draft.propertyId || !canAddFilter) return;

    const nextFilter: LensFilterCondition = {
      property: draft.propertyId,
      op: draft.operator,
    };
    if (requiresDraftValue) {
      nextFilter.value =
        draftProperty?.type === "checkbox"
          ? draft.value === "true"
          : draft.value;
    }

    onViewFiltersChange([...viewFilters, nextFilter]);
    updateDraft({ value: "" });
  };

  const handleRemoveViewFilter = (index: number) => {
    if (!onViewFiltersChange) return;
    onViewFiltersChange(
      viewFilters.filter((_, currentIndex) => currentIndex !== index),
    );
  };

  const handleClearViewFilters = () => {
    if (!onViewFiltersChange) return;
    onViewFiltersChange([]);
  };

  const toggleDirection = () => {
    setSortDirection((dir) => {
      const next = dir === "asc" ? "desc" : "asc";
      onSortChange?.(sortKey === QUERY_ORDER_SORT_KEY ? null : sortKey, next);
      return next;
    });
  };

  const setColumnSort = (key: string) => {
    if (sortKey === key) {
      if (key === QUERY_ORDER_SORT_KEY) return;
      toggleDirection();
      return;
    }
    const dir = defaultSortDirection(properties[key]);
    setSortKey(key);
    setSortDirection(dir);
    onSortChange?.(key === QUERY_ORDER_SORT_KEY ? null : key, dir);
  };

  const sortIndicator = (key: string) => {
    if (sortKey !== key || key === QUERY_ORDER_SORT_KEY) return null;
    return sortDirection === "asc" ? (
      <ChevronUp className="h-3.5 w-3.5 text-custom-text-300" />
    ) : (
      <ChevronDown className="h-3.5 w-3.5 text-custom-text-300" />
    );
  };

  const setColumnVisible = (propertyId: string, visible: boolean) => {
    setVisibleColumnIds((current) => {
      let next: string[];
      if (visible) {
        if (current.includes(propertyId)) return current;
        next = [...current, propertyId];
      } else {
        if (!current.includes(propertyId) || current.length === 1) {
          return current;
        }
        next = current.filter((id) => id !== propertyId);
      }
      onColumnsChange?.(next);
      return next;
    });
  };

  const addHiddenColumn = (propertyId: string) => {
    setVisibleColumnIds((current) => {
      if (current.includes(propertyId)) return current;
      const next = [...current, propertyId];
      onColumnsChange?.(next);
      return next;
    });
  };

  useEffect(() => {
    if (!activeResizeColumnId) return;

    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      const nextWidth = Math.max(
        MIN_COLUMN_WIDTH,
        Math.round(resizeState.startWidth + event.clientX - resizeState.startX),
      );

      setColumnWidths((current) => {
        if (current[resizeState.propertyId] === nextWidth) {
          return current;
        }

        const next = {
          ...current,
          [resizeState.propertyId]: nextWidth,
        };
        columnWidthsRef.current = next;
        return next;
      });
    };

    const stopResizing = () => {
      const resizeState = resizeStateRef.current;
      resizeStateRef.current = null;
      setActiveResizeColumnId(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      if (!resizeState) return;
      onColumnWidthsChange?.(columnWidthsRef.current);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [activeResizeColumnId, onColumnWidthsChange]);

  const rowHeightStyle =
    view.table?.row_height != null
      ? { height: `${view.table.row_height}px` }
      : undefined;

  const openRow = (filePath: string) => {
    onRowClick?.(filePath);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-custom-background-100 font-workspace text-[13px] text-custom-text-100">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-custom-border-300 px-3 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-semibold text-custom-text-200">
            {formattedCount} results
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <Popover open={filterPopoverOpen} onOpenChange={setFilterPopoverOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={toolbarButtonClassName}>
                <Filter className="h-4 w-4" />
                <span className="font-medium">Filter</span>
                {totalActiveFilterCount > 0 ? (
                  <span className="rounded bg-custom-background-80 px-1.5 py-0.5 text-xs text-custom-text-300">
                    {totalActiveFilterCount}
                  </span>
                ) : null}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="show-scrollbar flex w-[460px] max-h-[min(70vh,560px)] flex-col overflow-y-auto rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-none data-[state=open]:animate-none data-[state=closed]:animate-none"
            >
              <div className="border-b border-border px-3 py-2">
                <p className="text-sm font-medium text-foreground">Filters</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add filters to the current view and save them to this .cbase
                  file.
                </p>
              </div>

              <div className="space-y-3 px-3 py-3">
                <div className="space-y-2">
                  {definedFilterEntries.map(({ filter, key }) => (
                    <div
                      key={`defined:${key}`}
                      className="flex items-start justify-between gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    >
                      <span className="min-w-0 flex-1 text-foreground">
                        {formatFilterSummary(filter, properties)}
                      </span>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        Global
                      </Badge>
                    </div>
                  ))}

                  {viewFilters.map((filter, index) => (
                    <div
                      key={`view:${index}`}
                      className="flex items-start justify-between gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    >
                      <span className="min-w-0 flex-1 text-foreground">
                        {formatFilterSummary(filter, properties)}
                      </span>
                      <div className="flex items-center gap-1">
                        <Badge
                          variant="outline"
                          className="shrink-0 text-[10px]"
                        >
                          View
                        </Badge>
                        <button
                          type="button"
                          onClick={() => handleRemoveViewFilter(index)}
                          disabled={!onViewFiltersChange}
                          className="text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label="Remove filter"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {definedFilters.length === 0 && viewFilters.length === 0 ? (
                    <p className="py-2 text-xs text-muted-foreground">
                      No filters.
                    </p>
                  ) : null}
                </div>

                <div className="grid grid-cols-[1.2fr_1fr_1.2fr] gap-2">
                  <Select
                    value={draft.propertyId}
                    onValueChange={(value) => {
                      updateDraft({
                        propertyId: value,
                        operator: defaultFilterOperator(properties[value]),
                        value: "",
                      });
                    }}
                    disabled={!onViewFiltersChange || allColumns.length === 0}
                  >
                    <SelectTrigger className="h-9 min-w-0 border-border bg-background text-sm text-foreground">
                      <SelectValue placeholder="Property" />
                    </SelectTrigger>
                    <SelectContent>
                      {allColumns.map((column) => (
                        <SelectItem
                          key={column.propertyId}
                          value={column.propertyId}
                        >
                          {column.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={draft.operator}
                    onValueChange={(value) =>
                      updateDraft({ operator: value as FilterOperator })
                    }
                    disabled={!onViewFiltersChange || !draft.propertyId}
                  >
                    <SelectTrigger className="h-9 min-w-0 border-border bg-background text-sm text-foreground">
                      <SelectValue placeholder="Operator" />
                    </SelectTrigger>
                    <SelectContent>
                      {allowedDraftOperators.map((operator) => (
                        <SelectItem key={operator} value={operator}>
                          {FILTER_OPERATOR_LABELS[operator]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {requiresDraftValue ? (
                    draftProperty?.type === "checkbox" ? (
                      <Select
                        value={draft.value}
                        onValueChange={(value) => updateDraft({ value })}
                        disabled={!onViewFiltersChange}
                      >
                        <SelectTrigger className="h-9 min-w-0 border-border bg-background text-sm text-foreground">
                          <SelectValue placeholder="Value" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">true</SelectItem>
                          <SelectItem value="false">false</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : draftProperty?.options?.length ? (
                      <Select
                        value={draft.value}
                        onValueChange={(value) => updateDraft({ value })}
                        disabled={!onViewFiltersChange}
                      >
                        <SelectTrigger className="h-9 min-w-0 border-border bg-background text-sm text-foreground">
                          <SelectValue placeholder="Value" />
                        </SelectTrigger>
                        <SelectContent>
                          {draftProperty.options.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={draft.value}
                        onChange={(event) =>
                          updateDraft({ value: event.target.value })
                        }
                        placeholder="Value"
                        className="h-9 border-border bg-background text-sm"
                        disabled={!onViewFiltersChange}
                      />
                    )
                  ) : (
                    <div className="flex h-9 items-center rounded border border-dashed border-border px-2 text-xs text-muted-foreground">
                      No value needed
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleClearViewFilters}
                    disabled={!onViewFiltersChange || viewFilters.length === 0}
                    className="h-8 rounded px-1 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
                  >
                    Clear view filters
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleAddFilter}
                    disabled={!canAddFilter}
                    className="h-8 gap-1 rounded px-1 text-xs hover:bg-transparent"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add filter
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={toolbarButtonClassName}>
                <ArrowUpDown className="h-4 w-4" />
                <span className="font-medium">Sort</span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="flex w-[320px] flex-col overflow-hidden rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-none data-[state=open]:animate-none data-[state=closed]:animate-none"
            >
              <div className="border-b border-border px-3 py-2">
                <p className="text-sm font-medium text-foreground">Sort by</p>
              </div>
              <div className="px-3 py-3">
                <div className="flex gap-2">
                  <Select
                    value={sortKey}
                    onValueChange={(value) => {
                      const dir =
                        value === QUERY_ORDER_SORT_KEY
                          ? "asc"
                          : defaultSortDirection(properties[value]);
                      setSortKey(value);
                      setSortDirection(dir);
                      onSortChange?.(
                        value === QUERY_ORDER_SORT_KEY ? null : value,
                        dir,
                      );
                    }}
                  >
                    <SelectTrigger className="h-9 w-auto min-w-0 flex-1 border-border bg-background text-sm text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={QUERY_ORDER_SORT_KEY}>
                        query order
                      </SelectItem>
                      {allColumns.map((column) => (
                        <SelectItem
                          key={column.propertyId}
                          value={column.propertyId}
                        >
                          {column.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={sortDirection}
                    onValueChange={(value) => {
                      setSortDirection(value as SortDirection);
                      onSortChange?.(
                        sortKey === QUERY_ORDER_SORT_KEY ? null : sortKey,
                        value as SortDirection,
                      );
                    }}
                    disabled={sortKey === QUERY_ORDER_SORT_KEY}
                  >
                    <SelectTrigger className="h-9 w-auto min-w-[132px] shrink-0 border-border bg-background text-sm text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="desc">
                        {sortDirectionLabels.desc}
                      </SelectItem>
                      <SelectItem value="asc">
                        {sortDirectionLabels.asc}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={toolbarButtonClassName}>
                <span className="font-medium">Properties</span>
                <ChevronDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="show-scrollbar max-h-[min(70vh,560px)] w-64 overflow-y-auto shadow-none data-[state=open]:animate-none data-[state=closed]:animate-none"
            >
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {allColumns.map((column) => {
                const checked = visibleColumnIds.includes(column.propertyId);
                const isOnlyVisibleColumn =
                  checked && visibleColumnIds.length === 1;

                return (
                  <DropdownMenuCheckboxItem
                    key={column.propertyId}
                    checked={checked}
                    disabled={isOnlyVisibleColumn}
                    onCheckedChange={(nextChecked) =>
                      setColumnVisible(column.propertyId, Boolean(nextChecked))
                    }
                  >
                    {column.label}
                  </DropdownMenuCheckboxItem>
                );
              })}
              {hiddenColumnOptions.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Add to end</DropdownMenuLabel>
                  {hiddenColumnOptions.map((column) => (
                    <DropdownMenuItem
                      key={`add:${column.propertyId}`}
                      onSelect={() => addHiddenColumn(column.propertyId)}
                    >
                      {column.label}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="show-scrollbar min-h-0 flex-1 overflow-auto">
        <table
          className="w-full min-w-full table-fixed border-collapse bg-custom-background-100"
          style={
            tableMinWidth > 0 ? { minWidth: `${tableMinWidth}px` } : undefined
          }
        >
          <colgroup>
            {visibleColumns.map((column, index) => (
              <col
                key={column.propertyId}
                style={
                  index !== visibleColumns.length - 1
                    ? { width: `${getColumnWidth(column)}px` }
                    : {}
                }
              />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-custom-background-100">
            <tr className="h-11 border-b border-custom-border-300 text-[13px] font-medium text-custom-text-300">
              {visibleColumns.map((column, index) => (
                <th
                  key={column.propertyId}
                  className={
                    index === visibleColumns.length - 1
                      ? "relative px-3 text-left"
                      : "relative border-r border-custom-border-300 px-3 text-left"
                  }
                >
                  <button
                    type="button"
                    onClick={() => setColumnSort(column.propertyId)}
                    className={
                      index === visibleColumns.length - 1
                        ? "inline-flex w-full items-center justify-between gap-2 text-left hover:text-custom-text-200"
                        : "inline-flex w-full items-center justify-between gap-2 pr-3 text-left hover:text-custom-text-200"
                    }
                  >
                    <span>{column.label}</span>
                    {sortIndicator(column.propertyId)}
                  </button>
                  {index !== visibleColumns.length - 1 ? (
                    <button
                      type="button"
                      aria-label={`Resize ${column.label} column`}
                      title={`Resize ${column.label} column`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        resizeStateRef.current = {
                          propertyId: column.propertyId,
                          startWidth: getColumnWidth(column),
                          startX: event.clientX,
                        };
                        setActiveResizeColumnId(column.propertyId);
                      }}
                      className="absolute -right-1 top-0 z-10 h-full w-3 cursor-col-resize touch-none select-none border-0 bg-transparent p-0"
                    >
                      <span
                        className={
                          activeResizeColumnId === column.propertyId
                            ? "absolute left-1/2 top-2 bottom-2 w-px -translate-x-1/2 bg-custom-text-200"
                            : "absolute left-1/2 top-2 bottom-2 w-px -translate-x-1/2 bg-custom-border-300"
                        }
                      />
                    </button>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(visibleColumns.length, 1)}
                  className="px-4 py-10 text-center text-[13px] text-custom-text-300"
                >
                  No matching files
                </td>
              </tr>
            ) : (
              sortedRows.map((row) => (
                <tr
                  key={row.filePath}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer border-b border-custom-border-300 text-[13px] hover:bg-custom-background-80"
                  style={rowHeightStyle}
                  onClick={() => openRow(row.filePath)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openRow(row.filePath);
                    }
                  }}
                >
                  {visibleColumns.map((column, index) => (
                    <td
                      key={column.propertyId}
                      className={
                        index === visibleColumns.length - 1
                          ? "truncate px-3 text-custom-text-100"
                          : "truncate border-r border-custom-border-300 px-3 text-custom-text-100"
                      }
                    >
                      {formatPropertyValue(
                        resolvePropertyValue(
                          row,
                          column.propertyId,
                          properties,
                        ),
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
