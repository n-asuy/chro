/**
 * .cbase file format types
 * A cbase is a view definition over workspace files, treating rows as files
 * and columns as frontmatter properties.
 */

/** Property types supported in cbase schema */
export type CbasePropertyType =
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "select"
  | "multi_select"
  | "url";

/** A property definition in the cbase schema */
export interface CbaseProperty {
  /** Frontmatter key this property maps to */
  key: string;
  /** Display label (defaults to key if not provided) */
  label?: string;
  /** Data type */
  type: CbasePropertyType;
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
export interface CbaseFilterCondition {
  /** Property ID to filter on */
  property: string;
  /** Comparison operator */
  op: FilterOperator;
  /** Value to compare against (not needed for is_empty/is_not_empty) */
  value?: unknown;
}

/** Compound filter with logical operators */
export type CbaseFilter =
  | CbaseFilterCondition
  | { and: CbaseFilter[] }
  | { or: CbaseFilter[] }
  | { not: CbaseFilter };

/** Sort direction */
export type SortDirection = "asc" | "desc";

/** Sort specification */
export interface CbaseSort {
  /** Property ID to sort by */
  by: string;
  /** Sort direction */
  dir: SortDirection;
}

/** Table view configuration */
export interface CbaseTableView {
  /** Ordered list of property IDs to display as columns */
  columns: string[];
  /** Column widths in pixels */
  column_widths?: Record<string, number>;
  /** Row height in pixels */
  row_height?: number;
}

/** View definition */
export interface CbaseView {
  /** View identifier */
  id: string;
  /** Display name */
  name: string;
  /** View type */
  type: "table";
  /** Whether this is the default view */
  default?: boolean;
  /** View-level filters (combined with global filters via AND) */
  filters?: CbaseFilter[];
  /** View-level sort */
  sort?: CbaseSort[];
  /** Maximum rows to display */
  limit?: number;
  /** Table-specific configuration */
  table?: CbaseTableView;
}

/** Template for creating new rows (files) */
export interface CbaseTemplate {
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
export interface CbaseDataset {
  /** Glob patterns for included files */
  include: string[];
  /** Glob patterns for excluded files */
  exclude?: string[];
}

/** Root .cbase file structure */
export interface CbaseDefinition {
  /** Schema version */
  version: 1;
  /** Display name of this cbase */
  name: string;
  /** Optional description */
  description?: string;
  /** Dataset: which files are rows */
  dataset: CbaseDataset;
  /** Property definitions (key = property ID) */
  properties: Record<string, CbaseProperty>;
  /** Global filters applied to all views */
  filters?: CbaseFilter[];
  /** Global sort applied when view has no sort */
  sort?: CbaseSort[];
  /** View definitions */
  views: CbaseView[];
  /** Template for new row creation */
  template?: CbaseTemplate;
}

/** A single row in the cbase (represents a file) */
export interface CbaseRow {
  /** File path relative to workspace root */
  filePath: string;
  /** Display name of the file */
  displayName: string;
  /** File modified timestamp (ISO string) */
  modifiedAt?: string;
  /** Property values extracted from frontmatter */
  values: Record<string, unknown>;
}

/** Result of evaluating a cbase view */
export interface CbaseViewResult {
  /** The view definition */
  view: CbaseView;
  /** Filtered and sorted rows */
  rows: CbaseRow[];
  /** Total count before limit */
  totalCount: number;
}

/**
 * Materialized view payload produced by the backend: the parsed definition, the
 * effective (inferred) property schema, and the executed result of every view.
 * Mirrors the `cbase` crate's `CbaseDocument`.
 */
export interface CbaseDocument {
  /** The parsed definition (absent when parsing failed) */
  definition?: CbaseDefinition;
  /** Effective property schema (explicit + inferred), keyed by property ID */
  properties: Record<string, CbaseProperty>;
  /** Executed result for each view in definition order */
  views: CbaseViewResult[];
  /** Whether the source was written in the query language (read-only in the UI) */
  isQueryLanguage: boolean;
  /** Parse error message, set when the .cbase file is invalid */
  parseError?: string;
}
