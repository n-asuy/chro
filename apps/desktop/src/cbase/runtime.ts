import type { LensProperty, LensRow } from "./types";

export function resolvePropertyValue(
  row: LensRow,
  propertyId: string,
  properties: Record<string, LensProperty>,
): unknown {
  const property = properties[propertyId];
  if (!property) return undefined;

  if (property.key === "file.path") return row.filePath;
  if (property.key === "file.name") return row.displayName;
  if (property.key === "file.folder") {
    const normalized = row.filePath.replaceAll("\\", "/");
    const index = normalized.lastIndexOf("/");
    return index >= 0 ? normalized.slice(0, index) : "";
  }
  if (
    property.key === "file.mtime" ||
    property.key === "file.modified" ||
    property.key === "file.modifiedAt"
  ) {
    return row.modifiedAt;
  }
  if (property.key === "file.ext") {
    const normalized = row.filePath.replaceAll("\\", "/");
    const index = normalized.lastIndexOf(".");
    return index >= 0 ? normalized.slice(index + 1) : "";
  }

  return row.values[property.key];
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function toComparableNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value instanceof Date) return value.getTime();
  return 0;
}

function toComparableString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  return String(value);
}

export function comparePropertyValues(a: unknown, b: unknown): number {
  if (isEmptyValue(a) && isEmptyValue(b)) return 0;
  if (isEmptyValue(a)) return -1;
  if (isEmptyValue(b)) return 1;

  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number" || typeof b === "number") {
    return toComparableNumber(a) - toComparableNumber(b);
  }

  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (a instanceof Date || b instanceof Date) {
    const da =
      a instanceof Date
        ? a.getTime()
        : new Date(toComparableString(a)).getTime();
    const db =
      b instanceof Date
        ? b.getTime()
        : new Date(toComparableString(b)).getTime();

    if (!Number.isNaN(da) && !Number.isNaN(db)) {
      return da - db;
    }
  }

  if (typeof a === "boolean" && typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }

  return toComparableString(a).localeCompare(toComparableString(b));
}

export function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value.map((item) => String(item)).join(", ");
  }
  return String(value);
}

export function getColumnLabel(
  propertyId: string,
  properties: Record<string, LensProperty>,
): string {
  const property = properties[propertyId];
  if (!property) return propertyId;
  return property.label ?? property.key;
}
