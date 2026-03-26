/**
 * .cbase file format types
 * A lens is a view definition over workspace files, treating rows as files
 * and columns as frontmatter properties.
 */

/** Property types supported in lens schema */
export type LensPropertyType =
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "select"
  | "multi_select"
  | "url";

/** A property definition in the lens schema */
export interface LensProperty {
  /** Frontmatter key this property maps to */
  key: string;
  /** Display label (defaults to key if not provided) */
  label?: string;
  /** Data type */
  type: LensPropertyType;
  /** Whether this property is required */
  required?: boolean;
  /** Default value for new rows */
  default?: unknown;
  /** Options for select/multi_select types */
  options?: string[];
}

/** Filter comparison operators */
export type FilterOperator =
  | "="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">="
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty";

/** A single filter condition */
export interface LensFilterCondition {
  /** Property ID to filter on */
  property: string;
  /** Comparison operator */
  op: FilterOperator;
  /** Value to compare against (not needed for is_empty/is_not_empty) */
  value?: unknown;
}

/** Compound filter with logical operators */
export type LensFilter =
  | LensFilterCondition
  | { and: LensFilter[] }
  | { or: LensFilter[] }
  | { not: LensFilter };

/** Sort direction */
export type SortDirection = "asc" | "desc";

/** Sort specification */
export interface LensSort {
  /** Property ID to sort by */
  by: string;
  /** Sort direction */
  dir: SortDirection;
}

/** Table view configuration */
export interface LensTableView {
  /** Ordered list of property IDs to display as columns */
  columns: string[];
  /** Column widths in pixels */
  column_widths?: Record<string, number>;
  /** Row height in pixels */
  row_height?: number;
}

/** View definition */
export interface LensView {
  /** View identifier */
  id: string;
  /** Display name */
  name: string;
  /** View type */
  type: "table";
  /** Whether this is the default view */
  default?: boolean;
  /** View-level filters (combined with global filters via AND) */
  filters?: LensFilter[];
  /** View-level sort */
  sort?: LensSort[];
  /** Maximum rows to display */
  limit?: number;
  /** Table-specific configuration */
  table?: LensTableView;
}

/** Template for creating new rows (files) */
export interface LensTemplate {
  /** Target folder for new files */
  folder: string;
  /** Filename pattern (supports {{property_id}} and {{date:FORMAT}}) */
  filename: string;
  /** Initial frontmatter values */
  frontmatter?: Record<string, unknown>;
  /** Initial body content */
  body?: string;
}

/** Dataset definition - which files to include */
export interface LensDataset {
  /** Glob patterns for included files */
  include: string[];
  /** Glob patterns for excluded files */
  exclude?: string[];
}

/** Root .cbase file structure */
export interface LensDefinition {
  /** Schema version */
  version: 1;
  /** Display name of this lens */
  name: string;
  /** Optional description */
  description?: string;
  /** Dataset: which files are rows */
  dataset: LensDataset;
  /** Property definitions (key = property ID) */
  properties: Record<string, LensProperty>;
  /** Global filters applied to all views */
  filters?: LensFilter[];
  /** Global sort applied when view has no sort */
  sort?: LensSort[];
  /** View definitions */
  views: LensView[];
  /** Template for new row creation */
  template?: LensTemplate;
}

/** A single row in the lens (represents a file) */
export interface LensRow {
  /** File path relative to workspace root */
  filePath: string;
  /** Display name of the file */
  displayName: string;
  /** File modified timestamp (ISO string) */
  modifiedAt?: string;
  /** Property values extracted from frontmatter */
  values: Record<string, unknown>;
}

/** Result of evaluating a lens view */
export interface LensViewResult {
  /** The view definition */
  view: LensView;
  /** Filtered and sorted rows */
  rows: LensRow[];
  /** Total count before limit */
  totalCount: number;
}
