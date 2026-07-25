import { getColumnLabel, resolvePropertyValue } from "./runtime";
import type {
  CbaseDataset,
  CbaseProperty,
  CbasePropertyType,
  CbaseRow,
  CbaseView,
} from "./types";

interface CbaseTableColumn {
  propertyId: string;
  label: string;
  type: CbasePropertyType;
  width?: number;
}

const DEFAULT_COLUMN_KEYS = ["file.path", "file.name", "file.mtime"];

const compileCommonGlob = (glob: string): RegExp | null => {
  // Keep uncommon glob syntax conservative: matching everything costs one
  // refresh, whereas a false negative would leave the table stale.
  if (/[[\]{}()!+@]/.test(glob)) return null;
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char?.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${pattern}$`);
};

/** Conservative watcher filter for the common glob forms used by datasets. */
export function createDatasetPathFilter(
  dataset: CbaseDataset | undefined,
): (path: string) => boolean {
  const include = (dataset?.include ?? ["**/*.md"]).map(compileCommonGlob);
  const exclude = (dataset?.exclude ?? []).map(compileCommonGlob);
  return (path: string) => {
    const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
    const included = include.some(
      (matcher) => !matcher || matcher.test(normalized),
    );
    if (!included) return false;
    return !exclude.some((matcher) => matcher?.test(normalized) === true);
  };
}

function resolveDefaultColumns(
  properties: Record<string, CbaseProperty>,
): string[] {
  const keyToId = new Map<string, string>();
  for (const [id, prop] of Object.entries(properties)) {
    keyToId.set(prop.key, id);
  }

  const columns: string[] = [];
  for (const key of DEFAULT_COLUMN_KEYS) {
    const id = keyToId.get(key);
    if (id) columns.push(id);
  }
  return columns.length > 0 ? columns : Object.keys(properties);
}

export function resolveTableColumns(
  view: CbaseView,
  properties: Record<string, CbaseProperty>,
): CbaseTableColumn[] {
  const sourceColumns =
    view.table?.columns && view.table.columns.length > 0
      ? view.table.columns
      : resolveDefaultColumns(properties);

  return sourceColumns.map((propertyId) => {
    const property = properties[propertyId];

    return {
      propertyId,
      label: getColumnLabel(propertyId, properties),
      type: property?.type ?? "text",
      width: view.table?.column_widths?.[propertyId],
    };
  });
}

// ---------------------------------------------------------------------------
// Optimistic frontmatter overlay
//
// Inline edits are shown immediately and settle when the watcher-triggered
// re-query returns rows that reflect the written value. Keys pair the row's
// file path with the frontmatter key (not the property ID).
// ---------------------------------------------------------------------------

const OVERLAY_SEPARATOR = "\u0000";

export type PropertyOverlay = Record<string, unknown>;

export function overlayKey(filePath: string, frontmatterKey: string): string {
  return `${filePath}${OVERLAY_SEPARATOR}${frontmatterKey}`;
}

function splitOverlayKey(key: string): [string, string] {
  const index = key.indexOf(OVERLAY_SEPARATOR);
  return [key.slice(0, index), key.slice(index + 1)];
}

/** Merge pending optimistic values into the rows (no-op without entries). */
export function applyOverlay(
  rows: CbaseRow[],
  overlay: PropertyOverlay,
): CbaseRow[] {
  const entries = Object.entries(overlay);
  if (entries.length === 0) return rows;

  return rows.map((row) => {
    let values: Record<string, unknown> | null = null;
    for (const [key, value] of entries) {
      const [filePath, frontmatterKey] = splitOverlayKey(key);
      if (filePath !== row.filePath) continue;
      values = values ?? { ...row.values };
      if (value === null || value === undefined) {
        delete values[frontmatterKey];
      } else {
        values[frontmatterKey] = value;
      }
    }
    return values ? { ...row, values } : row;
  });
}

/**
 * Drop overlay entries that a freshly-queried document now reflects (or whose
 * row disappeared, e.g. the edit made it fall out of the filter). Entries for
 * still-stale rows survive, so an unrelated refresh racing a write cannot
 * momentarily revert the edited cell.
 */
export function settleOverlay(
  rows: CbaseRow[],
  overlay: PropertyOverlay,
): PropertyOverlay {
  const entries = Object.entries(overlay);
  if (entries.length === 0) return overlay;

  const byPath = new Map(rows.map((row) => [row.filePath, row]));
  const next: PropertyOverlay = {};
  let dropped = false;
  for (const [key, value] of entries) {
    const [filePath, frontmatterKey] = splitOverlayKey(key);
    const row = byPath.get(filePath);
    const settled =
      !row ||
      JSON.stringify(row.values[frontmatterKey] ?? null) ===
        JSON.stringify(value ?? null);
    if (settled) {
      dropped = true;
    } else {
      next[key] = value;
    }
  }
  return dropped ? next : overlay;
}

// ---------------------------------------------------------------------------
// Cell presentation and editing helpers
// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Compact date label for date-typed cells: "Jul 22" within the current year,
 * "Jul 22, 2025" otherwise. Returns null for values that are not dates, so the
 * caller can fall back to plain text.
 */
export function formatDateLabel(
  value: unknown,
  today = new Date(),
): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const month = MONTHS[date.getMonth()];
  const label = `${month} ${date.getDate()}`;
  return date.getFullYear() === today.getFullYear()
    ? label
    : `${label}, ${date.getFullYear()}`;
}

/** `date`-typed values normalized to the `yyyy-mm-dd` form date inputs use. */
export function toDateInputValue(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Options for a select cell: declared options plus values already in use. */
export function deriveSelectOptions(
  property: CbaseProperty | undefined,
  rows: CbaseRow[],
): string[] {
  const options = new Set<string>(property?.options ?? []);
  if (property) {
    for (const row of rows) {
      const value = row.values[property.key];
      if (typeof value === "string" && value.trim() !== "") options.add(value);
    }
  }
  return [...options];
}

/** Whether a property can be written back as frontmatter (file.* cannot). */
export function isEditableProperty(
  property: CbaseProperty | undefined,
): boolean {
  return !!property && !property.key.startsWith("file.");
}

/** Roving-focus move for arrow/tab keys; returns null when the key is not navigation. */
export function moveCellFocus(
  position: { row: number; col: number },
  key: string,
  rowCount: number,
  colCount: number,
): { row: number; col: number } | null {
  const clamp = (row: number, col: number) => ({
    row: Math.min(Math.max(row, 0), rowCount - 1),
    col: Math.min(Math.max(col, 0), colCount - 1),
  });
  switch (key) {
    case "ArrowUp":
      return clamp(position.row - 1, position.col);
    case "ArrowDown":
      return clamp(position.row + 1, position.col);
    case "ArrowLeft":
      return clamp(position.row, position.col - 1);
    case "ArrowRight":
    case "Tab":
      if (key === "Tab" && position.col === colCount - 1) {
        return position.row === rowCount - 1
          ? clamp(position.row, position.col)
          : clamp(position.row + 1, 0);
      }
      return clamp(position.row, position.col + 1);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// New note creation
// ---------------------------------------------------------------------------

/** The static folder prefix of the dataset's first include glob. */
export function datasetFolder(dataset: CbaseDataset | undefined): string {
  const first = dataset?.include[0] ?? "";
  const segments = first.split("/");
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (segment.includes("*") || segment.includes("?")) break;
    if (segment.includes(".")) break; // filename part
    staticSegments.push(segment);
  }
  return staticSegments.join("/");
}

/** First `untitled[-N].md` path (within `folder`) not present in `existing`. */
export function nextUntitledPath(
  folder: string,
  existing: Iterable<string>,
): string {
  const taken = new Set(existing);
  const prefix = folder ? `${folder}/` : "";
  for (let n = 0; ; n += 1) {
    const candidate = `${prefix}${n === 0 ? "untitled" : `untitled-${n}`}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Initial content for a new row: an empty-valued frontmatter block for every
 * visible editable property, so the row materializes with editable cells.
 */
export function newNoteContent(
  view: CbaseView,
  properties: Record<string, CbaseProperty>,
): string {
  const keys = resolveTableColumns(view, properties)
    .map((column) => properties[column.propertyId])
    .filter((property): property is CbaseProperty =>
      isEditableProperty(property),
    )
    .map((property) => property.key);
  if (keys.length === 0) return "";
  return `---\n${keys.map((key) => `${key}:`).join("\n")}\n---\n`;
}

/** Resolve the first-column display value used for the row's file link. */
export function resolveRowTitle(
  row: CbaseRow,
  firstColumnPropertyId: string | undefined,
  properties: Record<string, CbaseProperty>,
): string {
  if (firstColumnPropertyId) {
    const value = resolvePropertyValue(row, firstColumnPropertyId, properties);
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return row.displayName;
}
