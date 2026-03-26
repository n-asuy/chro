import { getColumnLabel } from "./runtime";
import type { LensProperty, LensPropertyType, LensView } from "./types";

interface LensTableColumn {
  propertyId: string;
  label: string;
  type: LensPropertyType;
  width?: number;
}

export function resolveTableColumns(
  view: LensView,
  properties: Record<string, LensProperty>,
): LensTableColumn[] {
  const sourceColumns =
    view.table?.columns && view.table.columns.length > 0
      ? view.table.columns
      : Object.keys(properties);

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
