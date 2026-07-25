/**
 * File database table over the materialized cbase document.
 *
 * Layout: view tabs on the toolbar's left, meta and actions on its right, a
 * filter chip row when filters exist, then the table. Cells render by property
 * type and edit inline; edits surface through `onCellEdit` and are applied
 * optimistically by the owner. Border hierarchy is strong under the header,
 * weak between rows, and no vertical rules.
 */

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@chro/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chro/ui/select";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  FileText,
  Filter,
  Plus,
  SlidersHorizontal,
  Table2,
  X,
} from "lucide-react";
import {
  type FC,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { comparePropertyValues, resolvePropertyValue } from "../runtime";
import type {
  CbaseFilter,
  CbaseFilterCondition,
  CbaseProperty,
  CbaseRow,
  CbaseView,
  FilterOperator,
  SortDirection,
} from "../types";
import {
  deriveSelectOptions,
  isEditableProperty,
  moveCellFocus,
  resolveRowTitle,
  resolveTableColumns,
} from "../view-model";
import { CellDisplay, CellEditor } from "./cbase-cells";

interface BaseTableProps {
  rows: CbaseRow[];
  totalCount: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  view: CbaseView;
  /** All views of the definition, rendered as tabs. */
  views: CbaseView[];
  activeViewId: string;
  onViewSelect?: (viewId: string) => void;
  properties: Record<string, CbaseProperty>;
  definedFilters?: CbaseFilter[];
  viewFilters?: CbaseFilter[];
  /** Whether definition changes (columns/sort/filters/widths) can be saved. */
  canPersist: boolean;
  /** Whether row frontmatter can be edited inline. */
  canEditRows: boolean;
  onOpenFile?: (filePath: string) => void;
  onCellEdit?: (
    filePath: string,
    frontmatterKey: string,
    value: unknown,
  ) => void;
  /** Fires when a cell editor opens or closes (owner holds live updates). */
  onEditingChange?: (editing: boolean) => void;
  onViewFiltersChange?: (filters: CbaseFilter[]) => void;
  onColumnsChange?: (columnIds: string[]) => void;
  onSortChange?: (sortKey: string | null, direction: SortDirection) => void;
  onColumnWidthsChange?: (columnWidths: Record<string, number>) => void;
  onNewNote?: () => void;
  onLoadMore?: () => void;
}

type FilterDraft = {
  propertyId: string;
  operator: FilterOperator;
  value: string;
};

type CellPosition = { row: number; col: number };

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

const toolbarButtonClassName =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-custom-text-200 transition-colors hover:bg-custom-background-90 hover:text-custom-text-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-custom-primary-100";

function createDraft(): FilterDraft {
  return { propertyId: "", operator: "contains", value: "" };
}

function getAllowedFilterOperators(property?: CbaseProperty): FilterOperator[] {
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

function defaultFilterOperator(property?: CbaseProperty): FilterOperator {
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
  property?: CbaseProperty,
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

  return { asc: "A to Z", desc: "Z to A" };
}

function defaultSortDirection(property?: CbaseProperty): SortDirection {
  return property?.type === "date" ? "desc" : "asc";
}

function isConditionFilter(
  filter: CbaseFilter,
): filter is CbaseFilterCondition {
  return !("and" in filter) && !("or" in filter) && !("not" in filter);
}

function formatConditionChip(
  filter: CbaseFilterCondition,
  properties: Record<string, CbaseProperty>,
): { label: string; op: string; value: string } {
  const property = properties[filter.property];
  return {
    label: property?.label ?? property?.key ?? filter.property,
    op: FILTER_OPERATOR_LABELS[filter.op],
    value: FILTER_OPS_WITHOUT_VALUE.includes(filter.op)
      ? ""
      : filterValueToString(filter.value),
  };
}

function formatFilterSummary(
  filter: CbaseFilter,
  properties: Record<string, CbaseProperty>,
): string {
  if (isConditionFilter(filter)) {
    const chip = formatConditionChip(filter, properties);
    return `${chip.label} ${chip.op}${chip.value ? ` ${chip.value}` : ""}`;
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

function createFilterEntries(filters: CbaseFilter[]) {
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
  hasMore,
  isLoadingMore,
  view,
  views,
  activeViewId,
  onViewSelect,
  properties,
  definedFilters = [],
  viewFilters = [],
  canPersist,
  canEditRows,
  onOpenFile,
  onCellEdit,
  onEditingChange,
  onViewFiltersChange,
  onColumnsChange,
  onSortChange,
  onColumnWidthsChange,
  onNewNote,
  onLoadMore,
}) => {
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [draft, setDraft] = useState<FilterDraft>(createDraft());
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  // Local sort is the fallback for read-only definitions (query-language
  // files); persistable definitions rely on the engine's ordering.
  const [localSortKey, setLocalSortKey] =
    useState<string>(QUERY_ORDER_SORT_KEY);
  const [localSortDirection, setLocalSortDirection] =
    useState<SortDirection>("asc");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => view.table?.column_widths ?? {},
  );
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[]>(() =>
    resolveTableColumns(view, properties).map((column) => column.propertyId),
  );
  const [focused, setFocused] = useState<CellPosition | null>(null);
  const [editing, setEditing] = useState<CellPosition | null>(null);
  const [activeResizeColumnId, setActiveResizeColumnId] = useState<
    string | null
  >(null);

  const tableRef = useRef<HTMLTableElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnWidthsRef = useRef(columnWidths);
  const resizeStateRef = useRef<{
    propertyId: string;
    startWidth: number;
    startX: number;
  } | null>(null);

  // Re-derive per-view UI state when the active view switches.
  const viewId = view.id;
  useEffect(() => {
    setColumnWidths(view.table?.column_widths ?? {});
    columnWidthsRef.current = view.table?.column_widths ?? {};
    setVisibleColumnIds(
      resolveTableColumns(view, properties).map((column) => column.propertyId),
    );
    setFocused(null);
    setEditing(null);
    // Only the view identity matters; properties refine labels lazily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId]);

  useEffect(() => {
    onEditingChange?.(editing !== null);
  }, [editing, onEditingChange]);

  const allColumns = useMemo(
    () =>
      Object.keys(properties).map((propertyId) => ({
        propertyId,
        label:
          properties[propertyId]?.label ??
          properties[propertyId]?.key ??
          propertyId,
        type: properties[propertyId]?.type ?? ("text" as const),
      })),
    [properties],
  );
  const columnMap = useMemo(
    () => new Map(allColumns.map((column) => [column.propertyId, column])),
    [allColumns],
  );
  const visibleColumns = useMemo(
    () =>
      visibleColumnIds
        .map((id) => columnMap.get(id))
        .filter((column): column is NonNullable<typeof column> => !!column),
    [visibleColumnIds, columnMap],
  );

  const hiddenColumnOptions = useMemo(
    () =>
      allColumns.filter(
        (column) => !visibleColumnIds.includes(column.propertyId),
      ),
    [allColumns, visibleColumnIds],
  );

  const selectOptionsByColumn = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const column of visibleColumns) {
      if (column.type === "select") {
        map.set(
          column.propertyId,
          deriveSelectOptions(properties[column.propertyId], rows),
        );
      }
    }
    return map;
  }, [visibleColumns, properties, rows]);

  // Engine order for persistable definitions; local fallback sort otherwise.
  const displayRows = useMemo(() => {
    if (canPersist || localSortKey === QUERY_ORDER_SORT_KEY) return rows;
    const sorted = [...rows].sort((a, b) => {
      const compared = comparePropertyValues(
        resolvePropertyValue(a, localSortKey, properties),
        resolvePropertyValue(b, localSortKey, properties),
      );
      return localSortDirection === "asc" ? compared : -compared;
    });
    return sorted;
  }, [rows, canPersist, localSortKey, localSortDirection, properties]);

  const estimatedRowHeight = Math.min(
    Math.max(view.table?.row_height ?? 36, 24),
    200,
  );
  const rowVirtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => displayRows[index]?.filePath ?? index,
    estimateSize: () => estimatedRowHeight,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop =
    virtualRows.length > 0 ? virtualRows[0]?.start ?? 0 : 0;
  const virtualPaddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() -
        (virtualRows[virtualRows.length - 1]?.end ?? 0)
      : 0;

  const activeSortKey = canPersist
    ? view.sort?.[0]?.by ?? QUERY_ORDER_SORT_KEY
    : localSortKey;
  const activeSortDirection: SortDirection = canPersist
    ? view.sort?.[0]?.dir ?? "asc"
    : localSortDirection;

  const totalActiveFilterCount = useMemo(
    () => definedFilters.length + viewFilters.length,
    [definedFilters, viewFilters],
  );

  const definedFilterEntries = useMemo(
    () => createFilterEntries(definedFilters),
    [definedFilters],
  );

  const draftProperty = properties[draft.propertyId];
  const draftNeedsValue = !FILTER_OPS_WITHOUT_VALUE.includes(draft.operator);

  const updateDraft = (patch: Partial<FilterDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const handleAddFilter = () => {
    if (!onViewFiltersChange || draft.propertyId === "") return;
    const property = properties[draft.propertyId];
    let condition: CbaseFilterCondition;
    if (draftNeedsValue) {
      let value: unknown = draft.value;
      if (property?.type === "checkbox") value = draft.value === "true";
      else if (property?.type === "number") {
        const parsed = Number(draft.value);
        value = Number.isFinite(parsed) ? parsed : draft.value;
      }
      condition = { property: draft.propertyId, op: draft.operator, value };
    } else {
      condition = { property: draft.propertyId, op: draft.operator };
    }
    onViewFiltersChange([...viewFilters, condition]);
    setDraft(createDraft());
    setFilterPopoverOpen(false);
  };

  const handleRemoveViewFilter = (index: number) => {
    if (!onViewFiltersChange) return;
    onViewFiltersChange(viewFilters.filter((_, i) => i !== index));
  };

  const setSort = (key: string, direction: SortDirection) => {
    if (canPersist) {
      onSortChange?.(key === QUERY_ORDER_SORT_KEY ? null : key, direction);
    } else {
      setLocalSortKey(key);
      setLocalSortDirection(direction);
    }
  };

  const handleHeaderSort = (propertyId: string) => {
    if (activeSortKey === propertyId) {
      setSort(propertyId, activeSortDirection === "asc" ? "desc" : "asc");
    } else {
      setSort(propertyId, defaultSortDirection(properties[propertyId]));
    }
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

  // --- column resize (pointer-driven, persisted on release) ---

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
        if (current[resizeState.propertyId] === nextWidth) return current;
        const next = { ...current, [resizeState.propertyId]: nextWidth };
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

  const getColumnWidth = (propertyId: string): number =>
    columnWidths[propertyId] ?? DEFAULT_COLUMN_WIDTH;

  const tableMinWidth = useMemo(
    () =>
      visibleColumns.reduce(
        (total, column) => total + getColumnWidth(column.propertyId),
        0,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleColumns, columnWidths],
  );

  // --- cell focus, keyboard navigation, and editing ---

  const focusCell = (position: CellPosition) => {
    setFocused(position);
    rowVirtualizer.scrollToIndex(position.row, { align: "auto" });
    requestAnimationFrame(() => {
      const cell = tableRef.current?.querySelector<HTMLTableCellElement>(
        `td[data-cell="${position.row}:${position.col}"]`,
      );
      cell?.focus();
    });
  };

  const commitCell = (row: CbaseRow, propertyId: string, value: unknown) => {
    const property = properties[propertyId];
    if (property) onCellEdit?.(row.filePath, property.key, value);
    setEditing(null);
  };

  const isCellEditable = (colIndex: number): boolean => {
    if (!canEditRows || !onCellEdit || colIndex === 0) return false;
    const column = visibleColumns[colIndex];
    return !!column && isEditableProperty(properties[column.propertyId]);
  };

  const handleCellKeyDown = (
    event: KeyboardEvent<HTMLTableCellElement>,
    position: CellPosition,
    row: CbaseRow,
  ) => {
    if (editing) return;
    const column = visibleColumns[position.col];
    if (!column) return;

    if (event.key === "Enter") {
      event.preventDefault();
      if (position.col === 0) {
        onOpenFile?.(row.filePath);
      } else if (column.type === "checkbox") {
        if (isCellEditable(position.col)) {
          const current = resolvePropertyValue(
            row,
            column.propertyId,
            properties,
          );
          commitCell(row, column.propertyId, current !== true);
        }
      } else if (isCellEditable(position.col)) {
        setEditing(position);
      }
      return;
    }
    if (event.key === " " && column.type === "checkbox") {
      event.preventDefault();
      if (isCellEditable(position.col)) {
        const current = resolvePropertyValue(
          row,
          column.propertyId,
          properties,
        );
        commitCell(row, column.propertyId, current !== true);
      }
      return;
    }
    if (event.key === "Escape") {
      (event.target as HTMLElement).blur();
      setFocused(null);
      return;
    }

    const next = moveCellFocus(
      position,
      event.key,
      displayRows.length,
      visibleColumns.length,
    );
    if (next) {
      event.preventDefault();
      focusCell(next);
    }
  };

  const handleCellClick = (position: CellPosition, row: CbaseRow) => {
    const column = visibleColumns[position.col];
    if (!column) return;
    if (position.col === 0) {
      onOpenFile?.(row.filePath);
      return;
    }
    setFocused(position);
    if (column.type === "checkbox") {
      if (isCellEditable(position.col)) {
        const current = resolvePropertyValue(
          row,
          column.propertyId,
          properties,
        );
        commitCell(row, column.propertyId, current !== true);
      }
      return;
    }
    if (isCellEditable(position.col)) setEditing(position);
  };

  const rowHeightStyle = { height: `${estimatedRowHeight}px` };

  const sortIndicator = (propertyId: string) => {
    if (activeSortKey !== propertyId) return null;
    return activeSortDirection === "asc" ? (
      <ChevronUp className="h-3.5 w-3.5 text-custom-text-300" />
    ) : (
      <ChevronDown className="h-3.5 w-3.5 text-custom-text-300" />
    );
  };

  const showFilterRow = totalActiveFilterCount > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-custom-background-100 font-workspace text-[13px] text-custom-text-100">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-custom-border-300 px-2.5 py-1.5">
        <div className="flex items-center gap-0.5">
          {views.map((tab) => (
            <button
              className={
                tab.id === activeViewId
                  ? "inline-flex items-center gap-1.5 rounded-md bg-custom-background-80 px-2.5 py-1 text-[13px] font-medium text-custom-text-100"
                  : "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] text-custom-text-300 transition-colors hover:text-custom-text-200"
              }
              key={tab.id}
              onClick={() => onViewSelect?.(tab.id)}
              type="button"
            >
              <Table2 className="h-3.5 w-3.5" />
              {tab.name}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-0.5">
          <span className="mr-2 text-xs tabular-nums text-custom-text-300">
            {rows.length < totalCount
              ? `${rows.length.toLocaleString()} shown · ${totalCount.toLocaleString()} matches`
              : `${totalCount.toLocaleString()} results`}
          </span>

          <Popover open={filterPopoverOpen} onOpenChange={setFilterPopoverOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={toolbarButtonClassName}>
                <Filter className="h-3.5 w-3.5" />
                Filter
                {totalActiveFilterCount > 0 ? (
                  <span className="rounded-full bg-custom-primary-100/10 px-1.5 text-[11px] leading-4 text-custom-primary-100 tabular-nums">
                    {totalActiveFilterCount}
                  </span>
                ) : null}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="w-[420px] p-0"
            >
              <div className="border-b border-custom-border-200 px-3 py-2">
                <p className="text-sm font-medium text-custom-text-100">
                  Add filter
                </p>
                <p className="mt-0.5 text-xs text-custom-text-300">
                  Saved to this view in the .cbase file.
                </p>
              </div>
              <div className="space-y-2 px-3 py-3">
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
                    <SelectTrigger className="h-8 min-w-0 text-sm">
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
                    disabled={!onViewFiltersChange || draft.propertyId === ""}
                  >
                    <SelectTrigger className="h-8 min-w-0 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {getAllowedFilterOperators(draftProperty).map((op) => (
                        <SelectItem key={op} value={op}>
                          {FILTER_OPERATOR_LABELS[op]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {draftNeedsValue ? (
                    draftProperty?.type === "checkbox" ? (
                      <Select
                        value={draft.value === "" ? "true" : draft.value}
                        onValueChange={(value) => updateDraft({ value })}
                        disabled={!onViewFiltersChange}
                      >
                        <SelectTrigger className="h-8 min-w-0 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">true</SelectItem>
                          <SelectItem value="false">false</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <input
                        className="h-8 min-w-0 rounded-md border border-custom-border-300 bg-custom-background-100 px-2 text-sm text-custom-text-100 outline-none focus:border-custom-primary-100"
                        onChange={(event) =>
                          updateDraft({ value: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") handleAddFilter();
                        }}
                        placeholder="Value"
                        value={draft.value}
                      />
                    )
                  ) : (
                    <div />
                  )}
                </div>
                <div className="flex justify-end">
                  <button
                    className="rounded-md bg-custom-primary-100/10 px-2.5 py-1 text-[13px] font-medium text-custom-primary-100 transition-colors hover:bg-custom-primary-100/15 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!onViewFiltersChange || draft.propertyId === ""}
                    onClick={handleAddFilter}
                    type="button"
                  >
                    Add filter
                  </button>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={toolbarButtonClassName}>
                <ArrowUpDown className="h-3.5 w-3.5" />
                Sort
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="w-[300px] p-3"
            >
              <div className="flex items-center gap-2">
                <Select
                  value={activeSortKey}
                  onValueChange={(value) =>
                    setSort(
                      value,
                      value === QUERY_ORDER_SORT_KEY
                        ? "asc"
                        : defaultSortDirection(properties[value]),
                    )
                  }
                >
                  <SelectTrigger className="h-8 min-w-0 flex-1 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={QUERY_ORDER_SORT_KEY}>
                      Query order
                    </SelectItem>
                    {visibleColumns.map((column) => (
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
                  value={activeSortDirection}
                  onValueChange={(value) =>
                    setSort(activeSortKey, value as SortDirection)
                  }
                  disabled={activeSortKey === QUERY_ORDER_SORT_KEY}
                >
                  <SelectTrigger className="h-8 w-auto min-w-[120px] shrink-0 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc">
                      {getSortDirectionLabels(properties[activeSortKey]).desc}
                    </SelectItem>
                    <SelectItem value="asc">
                      {getSortDirectionLabels(properties[activeSortKey]).asc}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={toolbarButtonClassName}>
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Properties
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="show-scrollbar max-h-[min(70vh,560px)] w-64 overflow-y-auto"
            >
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {visibleColumns.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.propertyId}
                  checked
                  disabled={visibleColumns.length === 1}
                  onCheckedChange={() =>
                    setColumnVisible(column.propertyId, false)
                  }
                >
                  {column.label}
                </DropdownMenuCheckboxItem>
              ))}
              {hiddenColumnOptions.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Hidden</DropdownMenuLabel>
                  {hiddenColumnOptions.map((column) => (
                    <DropdownMenuItem
                      key={`add:${column.propertyId}`}
                      onSelect={() => setColumnVisible(column.propertyId, true)}
                    >
                      {column.label}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          {onNewNote ? (
            <button
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium text-custom-primary-100 transition-colors hover:bg-custom-primary-100/10"
              onClick={onNewNote}
              type="button"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          ) : null}
        </div>
      </div>

      {showFilterRow ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-custom-border-200 px-2.5 py-1.5">
          {definedFilterEntries.map(({ filter, key }) => (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-custom-border-300 bg-custom-background-90 py-0.5 pl-2 pr-2 text-xs text-custom-text-200"
              key={`defined:${key}`}
              title={formatFilterSummary(filter, properties)}
            >
              {isConditionFilter(filter) ? (
                <FilterChipBody
                  chip={formatConditionChip(filter, properties)}
                />
              ) : (
                <span className="max-w-[280px] truncate">
                  {formatFilterSummary(filter, properties)}
                </span>
              )}
              <span className="border-l border-custom-border-300 pl-1.5 text-[10.5px] uppercase tracking-wide text-custom-text-400">
                base
              </span>
            </span>
          ))}

          {viewFilters.map((filter, index) => (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-custom-border-300 bg-custom-background-90 py-0.5 pl-2 pr-1 text-xs text-custom-text-200"
              key={`view:${JSON.stringify(filter)}:${index}`}
              title={formatFilterSummary(filter, properties)}
            >
              {isConditionFilter(filter) ? (
                <FilterChipBody
                  chip={formatConditionChip(filter, properties)}
                />
              ) : (
                <span className="max-w-[280px] truncate">
                  {formatFilterSummary(filter, properties)}
                </span>
              )}
              <button
                aria-label="Remove filter"
                className="rounded p-0.5 text-custom-text-300 transition-colors hover:text-custom-text-100 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!onViewFiltersChange}
                onClick={() => handleRemoveViewFilter(index)}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}

          {onViewFiltersChange ? (
            <button
              className="rounded-md px-1.5 py-0.5 text-xs text-custom-text-300 transition-colors hover:bg-custom-background-90 hover:text-custom-text-100"
              onClick={() => setFilterPopoverOpen(true)}
              type="button"
            >
              + Add filter
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        className={`show-scrollbar min-h-0 flex-1 ${
          editing ? "overflow-hidden" : "overflow-auto"
        }`}
        ref={scrollRef}
      >
        <table
          className="w-full min-w-full table-fixed border-separate border-spacing-0 bg-custom-background-100"
          ref={tableRef}
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
                    ? { width: `${getColumnWidth(column.propertyId)}px` }
                    : {}
                }
              />
            ))}
          </colgroup>
          <thead>
            <tr className="h-9 text-[12.5px] font-medium text-custom-text-300">
              {visibleColumns.map((column, index) => (
                <th
                  className="group/th sticky top-0 z-10 border-b border-custom-border-300 bg-custom-background-100 px-3 text-left font-medium"
                  key={column.propertyId}
                >
                  <button
                    className="inline-flex w-full items-center justify-between gap-2 text-left transition-colors hover:text-custom-text-100"
                    onClick={() => handleHeaderSort(column.propertyId)}
                    type="button"
                  >
                    <span className="truncate">{column.label}</span>
                    {sortIndicator(column.propertyId)}
                  </button>
                  {index !== visibleColumns.length - 1 ? (
                    <button
                      aria-label={`Resize ${column.label} column`}
                      className="absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize touch-none select-none border-0 bg-transparent p-0"
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
                          startWidth: getColumnWidth(column.propertyId),
                          startX: event.clientX,
                        };
                        setActiveResizeColumnId(column.propertyId);
                      }}
                      type="button"
                    >
                      <span
                        className={
                          activeResizeColumnId === column.propertyId
                            ? "absolute bottom-1.5 left-1/2 top-1.5 w-px -translate-x-1/2 bg-custom-primary-100"
                            : "absolute bottom-1.5 left-1/2 top-1.5 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/th:bg-custom-border-300"
                        }
                      />
                    </button>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td
                  className="px-4 py-10 text-center text-[13px] text-custom-text-300"
                  colSpan={Math.max(visibleColumns.length, 1)}
                >
                  No matching files
                </td>
              </tr>
            ) : (
              <>
                {virtualPaddingTop > 0 ? (
                  <tr aria-hidden>
                    <td
                      className="border-0 p-0"
                      colSpan={Math.max(visibleColumns.length, 1)}
                      style={{ height: `${virtualPaddingTop}px` }}
                    />
                  </tr>
                ) : null}
                {virtualRows.map((virtualRow) => {
                  const row = displayRows[virtualRow.index];
                  if (!row) return null;
                  const rowIndex = virtualRow.index;
                  return (
                    <tr
                      className="group/row text-[13px] hover:bg-custom-background-90"
                      data-index={rowIndex}
                      key={row.filePath}
                      ref={rowVirtualizer.measureElement}
                      style={rowHeightStyle}
                    >
                      {visibleColumns.map((column, colIndex) => {
                        const position = { row: rowIndex, col: colIndex };
                        const isEditing =
                          editing?.row === rowIndex && editing.col === colIndex;
                        const value = resolvePropertyValue(
                          row,
                          column.propertyId,
                          properties,
                        );
                        const editable = isCellEditable(colIndex);

                        return (
                          <td
                            className="relative h-9 border-b border-custom-border-100 px-0 text-custom-text-100 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-custom-primary-100"
                            data-cell={`${rowIndex}:${colIndex}`}
                            key={column.propertyId}
                            onClick={() => handleCellClick(position, row)}
                            onFocus={() => setFocused(position)}
                            onKeyDown={(event) =>
                              handleCellKeyDown(event, position, row)
                            }
                            tabIndex={
                              focused?.row === rowIndex &&
                              focused.col === colIndex
                                ? 0
                                : -1
                            }
                          >
                            {isEditing ? (
                              // Clicks inside the editor must not bubble to the
                              // cell, which would immediately re-open the editor
                              // that a commit just closed.
                              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard events are handled by the parent cell.
                              <div
                                className="flex min-h-9 items-center px-1.5"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <CellEditor
                                  onCancel={() => {
                                    setEditing(null);
                                    focusCell(position);
                                  }}
                                  onCommit={(next) => {
                                    commitCell(row, column.propertyId, next);
                                    focusCell(position);
                                  }}
                                  options={
                                    selectOptionsByColumn.get(
                                      column.propertyId,
                                    ) ?? []
                                  }
                                  type={column.type}
                                  value={value}
                                />
                              </div>
                            ) : colIndex === 0 ? (
                              <span className="flex min-h-9 cursor-pointer items-center gap-2 px-3 font-medium">
                                <FileText className="h-3.5 w-3.5 shrink-0 text-custom-text-300" />
                                <span className="truncate underline-offset-[3px] group-hover/row:[&:hover]:underline">
                                  {resolveRowTitle(
                                    row,
                                    column.propertyId,
                                    properties,
                                  )}
                                </span>
                              </span>
                            ) : column.type === "checkbox" ? (
                              <span className="flex min-h-9 items-center px-3">
                                <input
                                  checked={value === true}
                                  className="h-3.5 w-3.5 accent-custom-primary-100"
                                  disabled={!editable}
                                  onChange={() => {
                                    if (editable) {
                                      commitCell(
                                        row,
                                        column.propertyId,
                                        value !== true,
                                      );
                                    }
                                  }}
                                  onClick={(event) => event.stopPropagation()}
                                  type="checkbox"
                                />
                              </span>
                            ) : (
                              <span
                                className={
                                  editable
                                    ? "flex min-h-9 items-center rounded-[4px] px-3 ring-inset transition-shadow group-hover/row:[&:hover]:ring-1 group-hover/row:[&:hover]:ring-custom-border-300"
                                    : "flex min-h-9 items-center px-3"
                                }
                              >
                                <CellDisplay type={column.type} value={value} />
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {virtualPaddingBottom > 0 ? (
                  <tr aria-hidden>
                    <td
                      className="border-0 p-0"
                      colSpan={Math.max(visibleColumns.length, 1)}
                      style={{ height: `${virtualPaddingBottom}px` }}
                    />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
        {hasMore ? (
          <div className="flex justify-center border-t border-custom-border-200 px-3 py-3">
            <button
              className="rounded-md border border-custom-border-300 bg-custom-background-100 px-3 py-1.5 text-xs font-medium text-custom-text-200 transition-colors hover:bg-custom-background-90 disabled:cursor-wait disabled:opacity-60"
              disabled={isLoadingMore}
              onClick={onLoadMore}
              type="button"
            >
              {isLoadingMore ? "Loading…" : "Load 250 more"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const FilterChipBody: FC<{
  chip: { label: string; op: string; value: string };
}> = ({ chip }) => (
  <span className="flex max-w-[320px] items-center gap-1 truncate">
    <span className="font-semibold text-custom-text-100">{chip.label}</span>
    <span>{chip.op}</span>
    {chip.value !== "" ? (
      <span className="font-semibold text-custom-text-100">{chip.value}</span>
    ) : null}
  </span>
);
