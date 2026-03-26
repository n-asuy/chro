import type { LensProperty, LensPropertyType, LensRow } from "./types";

const BUILT_IN_PROPERTIES: Array<{
  key: string;
  label: string;
  type: LensPropertyType;
}> = [
  { key: "file.name", label: "Name", type: "text" },
  { key: "file.path", label: "Path", type: "text" },
  { key: "file.folder", label: "Folder", type: "text" },
  { key: "file.mtime", label: "Modified", type: "date" },
  { key: "file.ext", label: "Extension", type: "text" },
];

function sanitizePropertyId(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `auto_${slug || "property"}`;
}

function makeUniquePropertyId(
  key: string,
  properties: Record<string, LensProperty>,
): string {
  const baseId = sanitizePropertyId(key);
  let propertyId = baseId;
  let suffix = 2;

  while (properties[propertyId]) {
    propertyId = `${baseId}_${suffix}`;
    suffix += 1;
  }

  return propertyId;
}

function looksLikeDate(value: string): boolean {
  if (!value.trim()) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function looksLikeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function inferPropertyType(values: unknown[]): LensPropertyType {
  const samples = values.filter(
    (value) =>
      value !== null &&
      value !== undefined &&
      !(typeof value === "string" && value.trim() === ""),
  );

  if (samples.length === 0) return "text";
  if (samples.every((value) => Array.isArray(value))) return "multi_select";
  if (samples.every((value) => typeof value === "boolean")) return "checkbox";
  if (samples.every((value) => typeof value === "number")) return "number";
  if (samples.every((value) => typeof value === "string" && looksLikeDate(value))) {
    return "date";
  }
  if (samples.every((value) => typeof value === "string" && looksLikeUrl(value))) {
    return "url";
  }
  return "text";
}

function defaultLabel(key: string): string {
  const label = key
    .replace(/\./g, " ")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!label) return key;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function mergeInferredProperties(
  explicitProperties: Record<string, LensProperty>,
  rows: LensRow[],
): Record<string, LensProperty> {
  const merged: Record<string, LensProperty> = { ...explicitProperties };
  const knownKeys = new Set(
    Object.values(explicitProperties).map((property) => property.key),
  );

  for (const builtInProperty of BUILT_IN_PROPERTIES) {
    if (knownKeys.has(builtInProperty.key)) continue;
    const propertyId = makeUniquePropertyId(builtInProperty.key, merged);
    merged[propertyId] = {
      key: builtInProperty.key,
      label: builtInProperty.label,
      type: builtInProperty.type,
    };
    knownKeys.add(builtInProperty.key);
  }

  const valuesByKey = new Map<string, unknown[]>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.values)) {
      if (knownKeys.has(key)) continue;
      const current = valuesByKey.get(key) ?? [];
      current.push(value);
      valuesByKey.set(key, current);
    }
  }

  for (const [key, values] of valuesByKey.entries()) {
    if (knownKeys.has(key)) continue;
    const propertyId = makeUniquePropertyId(key, merged);
    merged[propertyId] = {
      key,
      label: defaultLabel(key),
      type: inferPropertyType(values),
    };
    knownKeys.add(key);
  }

  return merged;
}
