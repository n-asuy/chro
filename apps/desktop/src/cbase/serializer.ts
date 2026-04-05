/**
 * Serialize a LensDefinition back to .cbase YAML format.
 * Used to persist UI-driven view changes (column visibility, sort) to disk.
 */

import { stringify as stringifyYaml } from "yaml";
import type {
  LensDefinition,
  LensFilter,
  LensFilterCondition,
  LensProperty,
  LensSort,
  LensView,
} from "./types";

function serializeProperty(property: LensProperty): Record<string, unknown> {
  const out: Record<string, unknown> = {
    key: property.key,
    type: property.type,
  };
  if (property.label != null) out.label = property.label;
  if (property.required != null) out.required = property.required;
  if (property.default !== undefined) out.default = property.default;
  if (property.options?.length) out.options = property.options;
  return out;
}

function serializeFilter(filter: LensFilter): Record<string, unknown> {
  if ("and" in filter) {
    return { and: filter.and.map(serializeFilter) };
  }
  if ("or" in filter) {
    return { or: filter.or.map(serializeFilter) };
  }
  if ("not" in filter) {
    return { not: serializeFilter(filter.not) };
  }
  const condition = filter as LensFilterCondition;
  const out: Record<string, unknown> = {
    property: condition.property,
    op: condition.op,
  };
  if (condition.value !== undefined) out.value = condition.value;
  return out;
}

function serializeSort(sort: LensSort): Record<string, unknown> {
  return { by: sort.by, dir: sort.dir };
}

function serializeView(view: LensView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: view.id,
    name: view.name,
    type: view.type,
  };
  if (view.default) out.default = true;
  if (view.filters?.length) out.filters = view.filters.map(serializeFilter);
  if (view.sort?.length) out.sort = view.sort.map(serializeSort);
  if (view.limit != null) out.limit = view.limit;
  if (view.table) {
    const table: Record<string, unknown> = {
      columns: view.table.columns,
    };
    if (view.table.column_widths) table.column_widths = view.table.column_widths;
    if (view.table.row_height != null) table.row_height = view.table.row_height;
    out.table = table;
  }
  return out;
}

export function serializeLens(definition: LensDefinition): string {
  const out: Record<string, unknown> = {
    version: definition.version,
    name: definition.name,
  };
  if (definition.description) out.description = definition.description;

  out.dataset = {
    include: definition.dataset.include,
    ...(definition.dataset.exclude?.length
      ? { exclude: definition.dataset.exclude }
      : {}),
  };

  const props: Record<string, Record<string, unknown>> = {};
  for (const [id, prop] of Object.entries(definition.properties)) {
    props[id] = serializeProperty(prop);
  }
  out.properties = props;

  if (definition.filters?.length) {
    out.filters = definition.filters.map(serializeFilter);
  }
  if (definition.sort?.length) {
    out.sort = definition.sort.map(serializeSort);
  }

  out.views = definition.views.map(serializeView);

  if (definition.template) {
    const tmpl: Record<string, unknown> = {
      folder: definition.template.folder,
      filename: definition.template.filename,
    };
    if (definition.template.frontmatter) {
      tmpl.frontmatter = definition.template.frontmatter;
    }
    if (definition.template.body) tmpl.body = definition.template.body;
    out.template = tmpl;
  }

  return stringifyYaml(out, { lineWidth: 0 });
}
