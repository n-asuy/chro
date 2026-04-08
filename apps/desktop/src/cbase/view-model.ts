import { getColumnLabel } from "./runtime";
import type { CbaseProperty, CbasePropertyType, CbaseView } from "./types";

interface CbaseTableColumn {
  propertyId: string;
  label: string;
  type: CbasePropertyType;
  width?: number;
}

const DEFAULT_COLUMN_KEYS = ["file.path", "file.name", "file.mtime"];

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
