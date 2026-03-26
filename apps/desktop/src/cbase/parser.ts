/**
 * .cbase YAML parser
 * Parses and validates .cbase file content into a LensDefinition
 */

import { parse as parseYaml } from "yaml";
import {
  QueryLanguageParseError,
  looksLikeQueryLanguage,
  parseQueryLanguageToLensDefinition,
} from "./query-language";
import type {
  FilterOperator,
  LensDataset,
  LensDefinition,
  LensFilter,
  LensFilterCondition,
  LensProperty,
  LensPropertyType,
  LensSort,
  LensTableView,
  LensTemplate,
  LensView,
  SortDirection,
} from "./types";

/** Error thrown when .cbase file parsing or validation fails */
export class LensParseError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "LensParseError";
  }
}

interface ParseLensOptions {
  /** Relative path of the .cbase file currently being parsed */
  basePath?: string;
}

const VALID_PROPERTY_TYPES: LensPropertyType[] = [
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi_select",
  "url",
];

const VALID_FILTER_OPERATORS: FilterOperator[] = [
  "=",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
];

const VALID_SORT_DIRECTIONS: SortDirection[] = ["asc", "desc"];

/**
 * Parse a .cbase YAML string into a validated LensDefinition
 */
export function parseLens(
  content: string,
  options?: ParseLensOptions,
): LensDefinition {
  if (looksLikeQueryLanguage(content)) {
    try {
      return parseQueryLanguageToLensDefinition(content, undefined, {
        basePath: options?.basePath,
      });
    } catch (e) {
      throw new LensParseError(
        e instanceof QueryLanguageParseError ? e.message : String(e),
        "query",
      );
    }
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    if (looksLikeQueryLanguage(content)) {
      try {
        return parseQueryLanguageToLensDefinition(content, undefined, {
          basePath: options?.basePath,
        });
      } catch (queryError) {
        throw new LensParseError(
          queryError instanceof QueryLanguageParseError
            ? queryError.message
            : String(queryError),
          "query",
        );
      }
    }
    throw new LensParseError(
      `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (typeof raw === "string" && looksLikeQueryLanguage(raw)) {
      try {
        return parseQueryLanguageToLensDefinition(raw, undefined, {
          basePath: options?.basePath,
        });
      } catch (e) {
        throw new LensParseError(
          e instanceof QueryLanguageParseError ? e.message : String(e),
          "query",
        );
      }
    }

    throw new LensParseError(
      "Base file must be a YAML object or a query block",
    );
  }

  const obj = raw as Record<string, unknown>;

  // version
  if (obj.version !== 1) {
    throw new LensParseError(
      `Unsupported version: ${String(obj.version)}. Expected 1`,
      "version",
    );
  }

  // name
  if (typeof obj.name !== "string" || !obj.name.trim()) {
    throw new LensParseError(
      "'name' is required and must be a non-empty string",
      "name",
    );
  }

  // description
  const description =
    obj.description != null ? String(obj.description) : undefined;

  // Query-language mode
  if (obj.query != null) {
    if (typeof obj.query !== "string" || !obj.query.trim()) {
      throw new LensParseError("'query' must be a non-empty string", "query");
    }

    const hasLegacyFields =
      obj.dataset != null ||
      obj.properties != null ||
      obj.views != null ||
      obj.filters != null ||
      obj.sort != null;
    if (hasLegacyFields) {
      throw new LensParseError(
        "When 'query' is set, dataset/properties/views/filters/sort must be omitted",
        "query",
      );
    }

    try {
      return parseQueryLanguageToLensDefinition(
        obj.query,
        {
          name: obj.name as string,
          description,
        },
        {
          basePath: options?.basePath,
        },
      );
    } catch (e) {
      throw new LensParseError(
        e instanceof QueryLanguageParseError ? e.message : String(e),
        "query",
      );
    }
  }

  // dataset
  const dataset = parseDataset(obj.dataset);

  // properties
  const properties = parseProperties(obj.properties);

  // filters
  const filters =
    obj.filters != null
      ? parseFilters(obj.filters, "filters", properties)
      : undefined;

  // sort
  const sort =
    obj.sort != null ? parseSortList(obj.sort, "sort", properties) : undefined;

  // views
  const views = parseViews(obj.views, properties);

  // template
  const template =
    obj.template != null ? parseTemplate(obj.template) : undefined;

  return {
    version: 1,
    name: obj.name as string,
    description,
    dataset,
    properties,
    filters,
    sort,
    views,
    template,
  };
}

function parseDataset(raw: unknown): LensDataset {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LensParseError(
      "'dataset' is required and must be an object",
      "dataset",
    );
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.include) || obj.include.length === 0) {
    throw new LensParseError(
      "'dataset.include' must be a non-empty array of glob patterns",
      "dataset.include",
    );
  }
  const include = obj.include.map((v: unknown) => {
    if (typeof v !== "string") {
      throw new LensParseError(
        "dataset.include items must be strings",
        "dataset.include",
      );
    }
    return v;
  });

  let exclude: string[] | undefined;
  if (obj.exclude != null) {
    if (!Array.isArray(obj.exclude)) {
      throw new LensParseError(
        "dataset.exclude must be an array",
        "dataset.exclude",
      );
    }
    exclude = obj.exclude.map((v: unknown) => {
      if (typeof v !== "string") {
        throw new LensParseError(
          "dataset.exclude items must be strings",
          "dataset.exclude",
        );
      }
      return v;
    });
  }

  return { include, exclude };
}

function parseProperties(raw: unknown): Record<string, LensProperty> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LensParseError(
      "'properties' is required and must be an object",
      "properties",
    );
  }
  const obj = raw as Record<string, unknown>;
  const result: Record<string, LensProperty> = {};

  for (const [id, value] of Object.entries(obj)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new LensParseError(
        `Property '${id}' must be an object`,
        `properties.${id}`,
      );
    }
    const prop = value as Record<string, unknown>;

    if (typeof prop.key !== "string" || !prop.key.trim()) {
      throw new LensParseError(
        `Property '${id}' must have a 'key' string`,
        `properties.${id}.key`,
      );
    }

    const type = prop.type as string;
    if (!VALID_PROPERTY_TYPES.includes(type as LensPropertyType)) {
      throw new LensParseError(
        `Property '${id}' has invalid type '${type}'. Valid: ${VALID_PROPERTY_TYPES.join(", ")}`,
        `properties.${id}.type`,
      );
    }

    const property: LensProperty = {
      key: prop.key as string,
      type: type as LensPropertyType,
    };

    if (prop.label != null) property.label = String(prop.label);
    if (prop.required != null) property.required = Boolean(prop.required);
    if (prop.default !== undefined) property.default = prop.default;
    if (prop.options != null) {
      if (!Array.isArray(prop.options)) {
        throw new LensParseError(
          `Property '${id}' options must be an array`,
          `properties.${id}.options`,
        );
      }
      property.options = prop.options.map((v: unknown) => String(v));
    }

    result[id] = property;
  }

  return result;
}

function parseFilters(
  raw: unknown,
  path: string,
  properties: Record<string, LensProperty>,
): LensFilter[] {
  if (!Array.isArray(raw)) {
    throw new LensParseError(`'${path}' must be an array`, path);
  }
  return raw.map((item: unknown, i: number) =>
    parseFilter(item, `${path}[${i}]`, properties),
  );
}

function parseFilter(
  raw: unknown,
  path: string,
  properties: Record<string, LensProperty>,
): LensFilter {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LensParseError(`Filter at '${path}' must be an object`, path);
  }
  const obj = raw as Record<string, unknown>;

  // Compound filters
  if ("and" in obj) {
    return { and: parseFilters(obj.and, `${path}.and`, properties) };
  }
  if ("or" in obj) {
    return { or: parseFilters(obj.or, `${path}.or`, properties) };
  }
  if ("not" in obj) {
    return { not: parseFilter(obj.not, `${path}.not`, properties) };
  }

  // Simple condition
  if (typeof obj.property !== "string") {
    throw new LensParseError(
      `Filter at '${path}' must have a 'property' string`,
      path,
    );
  }
  if (!Object.hasOwn(properties, obj.property)) {
    throw new LensParseError(
      `Filter at '${path}' references unknown property '${obj.property}'`,
      `${path}.property`,
    );
  }
  if (!VALID_FILTER_OPERATORS.includes(obj.op as FilterOperator)) {
    throw new LensParseError(
      `Filter at '${path}' has invalid operator '${String(obj.op)}'`,
      path,
    );
  }

  const condition: LensFilterCondition = {
    property: obj.property as string,
    op: obj.op as FilterOperator,
  };

  if (obj.value !== undefined) {
    condition.value = obj.value;
  }

  return condition;
}

function parseSortList(
  raw: unknown,
  path: string,
  properties: Record<string, LensProperty>,
): LensSort[] {
  if (!Array.isArray(raw)) {
    throw new LensParseError(`'${path}' must be an array`, path);
  }
  return raw.map((item: unknown, i: number) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new LensParseError(
        `Sort at '${path}[${i}]' must be an object`,
        `${path}[${i}]`,
      );
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.by !== "string") {
      throw new LensParseError(
        `Sort at '${path}[${i}]' must have a 'by' string`,
        `${path}[${i}].by`,
      );
    }
    if (!Object.hasOwn(properties, obj.by)) {
      throw new LensParseError(
        `Sort at '${path}[${i}]' references unknown property '${obj.by}'`,
        `${path}[${i}].by`,
      );
    }
    const dir = (obj.dir as string) ?? "asc";
    if (!VALID_SORT_DIRECTIONS.includes(dir as SortDirection)) {
      throw new LensParseError(
        `Sort at '${path}[${i}]' has invalid direction '${dir}'`,
        `${path}[${i}].dir`,
      );
    }
    return { by: obj.by as string, dir: dir as SortDirection };
  });
}

function parseViews(
  raw: unknown,
  properties: Record<string, LensProperty>,
): LensView[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new LensParseError("'views' must be a non-empty array", "views");
  }

  const views: LensView[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new LensParseError(
        `View at index ${i} must be an object`,
        `views[${i}]`,
      );
    }
    const obj = item as Record<string, unknown>;

    if (typeof obj.id !== "string" || !obj.id.trim()) {
      throw new LensParseError(
        `View at index ${i} must have an 'id' string`,
        `views[${i}].id`,
      );
    }
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      throw new LensParseError(
        `View at index ${i} must have a 'name' string`,
        `views[${i}].name`,
      );
    }
    if (obj.type !== "table") {
      throw new LensParseError(
        `View '${obj.id}' has unsupported type '${String(obj.type)}'. Currently only 'table' is supported`,
        `views[${i}].type`,
      );
    }

    const view: LensView = {
      id: obj.id as string,
      name: obj.name as string,
      type: "table",
    };

    if (obj.default != null) view.default = Boolean(obj.default);
    if (obj.filters != null)
      view.filters = parseFilters(
        obj.filters,
        `views[${i}].filters`,
        properties,
      );
    if (obj.sort != null)
      view.sort = parseSortList(obj.sort, `views[${i}].sort`, properties);
    if (obj.limit != null) {
      if (typeof obj.limit !== "number" || obj.limit < 1) {
        throw new LensParseError(
          `View '${obj.id}' limit must be a positive number`,
          `views[${i}].limit`,
        );
      }
      view.limit = obj.limit;
    }

    if (obj.table != null) {
      view.table = parseTableView(obj.table, `views[${i}].table`, properties);
    } else {
      // Auto-generate table config from properties
      view.table = {
        columns: Object.keys(properties),
      };
    }

    views.push(view);
  }

  // Ensure exactly one default view
  const defaultViews = views.filter((v) => v.default);
  if (defaultViews.length === 0 && views.length > 0) {
    views[0].default = true;
  }

  return views;
}

function parseTableView(
  raw: unknown,
  path: string,
  properties: Record<string, LensProperty>,
): LensTableView {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LensParseError(`'${path}' must be an object`, path);
  }
  const obj = raw as Record<string, unknown>;

  const columns = Array.isArray(obj.columns)
    ? obj.columns.map((v: unknown) => String(v))
    : Object.keys(properties);

  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    if (!Object.hasOwn(properties, column)) {
      throw new LensParseError(
        `'${path}.columns[${i}]' references unknown property '${column}'`,
        `${path}.columns[${i}]`,
      );
    }
  }

  const result: LensTableView = { columns };

  if (obj.column_widths != null) {
    if (
      typeof obj.column_widths !== "object" ||
      Array.isArray(obj.column_widths)
    ) {
      throw new LensParseError(
        `'${path}.column_widths' must be an object`,
        `${path}.column_widths`,
      );
    }
    result.column_widths = {};
    for (const [k, v] of Object.entries(
      obj.column_widths as Record<string, unknown>,
    )) {
      result.column_widths[k] = typeof v === "number" ? v : 200;
    }
  }

  if (typeof obj.row_height === "number") {
    result.row_height = obj.row_height;
  }

  return result;
}

function parseTemplate(raw: unknown): LensTemplate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LensParseError("'template' must be an object", "template");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.folder !== "string") {
    throw new LensParseError(
      "'template.folder' must be a string",
      "template.folder",
    );
  }
  if (typeof obj.filename !== "string") {
    throw new LensParseError(
      "'template.filename' must be a string",
      "template.filename",
    );
  }

  const template: LensTemplate = {
    folder: obj.folder as string,
    filename: obj.filename as string,
  };

  if (obj.frontmatter != null && typeof obj.frontmatter === "object") {
    template.frontmatter = obj.frontmatter as Record<string, unknown>;
  }
  if (typeof obj.body === "string") {
    template.body = obj.body;
  }

  return template;
}

