/**
 * Frontmatter parsing and serialization utilities
 * Provides Obsidian-compatible YAML frontmatter handling
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * A frontmatter value the property UI can render in a single input
 */
export type FrontmatterScalar = string | number | boolean;

/**
 * Represents a single frontmatter property value
 *
 * Mirrors what YAML can express, including nested maps and lists. The property
 * UI can only edit a subset of it (see `getFrontmatterValueType`), but parsing
 * must never narrow a value it cannot edit: a document is re-serialized on
 * every body edit, so a lossy parse silently rewrites the file.
 */
export type FrontmatterValue =
  | FrontmatterScalar
  | Date
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue }
  | null;

/**
 * Represents the parsed frontmatter as a key-value record
 */
export type Frontmatter = Record<string, FrontmatterValue>;

/**
 * Result of parsing markdown content with frontmatter
 */
interface ParsedContent {
  frontmatter: Frontmatter;
  body: string;
  /** Raw YAML string (for debugging/display) */
  rawYaml: string;
}

/**
 * Regex to match YAML frontmatter block at the start of a document
 * Matches:
 * - Opening `---` at the very start (^---)
 * - Any content until closing `---` or `...` on its own line
 */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Parse markdown content and extract frontmatter
 *
 * @param content - The full markdown content
 * @returns ParsedContent with frontmatter object, body, and raw YAML
 *
 * @example
 * ```ts
 * const { frontmatter, body } = parseFrontmatter(`---
 * title: Hello World
 * tags:
 *   - typescript
 *   - markdown
 * ---
 *
 * # Content here
 * `);
 * // frontmatter = { title: "Hello World", tags: ["typescript", "markdown"] }
 * // body = "\n# Content here\n"
 * ```
 */
export function parseFrontmatter(content: string): ParsedContent {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return {
      frontmatter: {},
      body: content,
      rawYaml: "",
    };
  }

  const rawYaml = match[1] ?? "";
  const body = content.slice(match[0].length);

  try {
    const parsed: unknown = parseYaml(rawYaml);
    const frontmatter: Frontmatter =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Frontmatter)
        : {};

    return { frontmatter, body, rawYaml };
  } catch {
    // If YAML parsing fails, return empty frontmatter but preserve the body
    return {
      frontmatter: {},
      body: content.slice(match[0].length),
      rawYaml,
    };
  }
}

/**
 * Serialize frontmatter object back to YAML string
 *
 * @param frontmatter - The frontmatter object to serialize
 * @returns YAML string (without the --- delimiters)
 */
export function serializeFrontmatter(frontmatter: Frontmatter): string {
  if (Object.keys(frontmatter).length === 0) {
    return "";
  }

  // Prepare values for YAML serialization
  const prepared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== null && value !== undefined) {
      prepared[key] = value;
    }
  }

  return stringifyYaml(prepared, {
    indent: 2,
    lineWidth: 0, // Disable line wrapping
    singleQuote: false,
  }).trim();
}

/**
 * Combine frontmatter and body into full markdown content
 *
 * @param frontmatter - The frontmatter object
 * @param body - The markdown body content
 * @returns Full markdown string with frontmatter block
 */
export function combineFrontmatterAndBody(
  frontmatter: Frontmatter,
  body: string,
): string {
  const yaml = serializeFrontmatter(frontmatter);

  if (!yaml) {
    return body;
  }

  // Always add a newline between the closing delimiter and the body.
  // The newline immediately following the closing `---` is consumed when parsing
  // the document, so we need to re-insert it here to preserve the original spacing.
  return `---\n${yaml}\n---\n${body}`;
}

/**
 * Update a single property in the frontmatter
 *
 * @param content - The full markdown content
 * @param key - The property key to update
 * @param value - The new value (null to remove)
 * @returns Updated markdown content
 */
export function updateFrontmatterProperty(
  content: string,
  key: string,
  value: FrontmatterValue,
): string {
  const { frontmatter, body } = parseFrontmatter(content);

  if (value === null) {
    delete frontmatter[key];
  } else {
    frontmatter[key] = value;
  }

  return combineFrontmatterAndBody(frontmatter, body);
}

/**
 * Add a tag to the frontmatter tags array
 *
 * @param content - The full markdown content
 * @param tag - The tag to add
 * @returns Updated markdown content
 */
export function addTag(content: string, tag: string): string {
  const { frontmatter, body } = parseFrontmatter(content);
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];

  if (!tags.includes(tag)) {
    tags.push(tag);
    frontmatter.tags = tags;
  }

  return combineFrontmatterAndBody(frontmatter, body);
}

/**
 * Remove a tag from the frontmatter tags array
 *
 * @param content - The full markdown content
 * @param tag - The tag to remove
 * @returns Updated markdown content
 */
export function removeTag(content: string, tag: string): string {
  const { frontmatter, body } = parseFrontmatter(content);
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];

  const filtered = tags.filter((t) => t !== tag);
  frontmatter.tags = filtered.length > 0 ? filtered : null;

  return combineFrontmatterAndBody(frontmatter, body);
}

/**
 * Check if content has frontmatter
 */
export function hasFrontmatter(content: string): boolean {
  return FRONTMATTER_REGEX.test(content);
}

/**
 * The shape of a frontmatter value, as the property UI sees it
 *
 * `nested` covers maps and lists holding structure. The UI has no input that
 * can represent those, so it must show them read-only rather than flatten them.
 */
export type FrontmatterValueType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "tags"
  | "nested"
  | "null";

function isScalar(value: FrontmatterValue): value is FrontmatterScalar {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Get the type of a frontmatter value for UI display
 */
export function getFrontmatterValueType(
  value: FrontmatterValue,
): FrontmatterValueType {
  if (value === null) return "null";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) {
    return value.every(isScalar) ? "tags" : "nested";
  }
  return "nested";
}

/**
 * Render a nested value as YAML for read-only display
 */
export function formatNestedValue(value: FrontmatterValue): string {
  return stringifyYaml(value, { indent: 2, lineWidth: 0 }).trim();
}

/**
 * Format a Date value for display/editing
 */
export function formatDateValue(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().split("T")[0] ?? "";
}

/**
 * Parse a date string to Date object
 */
export function parseDateValue(str: string): Date | null {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}
