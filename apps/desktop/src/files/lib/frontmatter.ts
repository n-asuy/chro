/**
 * Frontmatter parsing and serialization utilities
 * Provides Obsidian-compatible YAML frontmatter handling
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Represents a single frontmatter property value
 * Supports string, number, boolean, date, array of strings, or null
 */
export type FrontmatterValue =
  | string
  | number
  | boolean
  | Date
  | string[]
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
    const parsed = parseYaml(rawYaml);
    const frontmatter: Frontmatter =
      typeof parsed === "object" && parsed !== null ? parsed : {};

    // Normalize values to supported types
    for (const key of Object.keys(frontmatter)) {
      frontmatter[key] = normalizeValue(frontmatter[key]);
    }

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
 * Normalize a parsed YAML value to a supported FrontmatterValue type
 */
function normalizeValue(value: unknown): FrontmatterValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    // Convert array items to strings
    return value.map((item) => String(item));
  }

  // For objects or other types, convert to string representation
  return String(value);
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
 * Get the type of a frontmatter value for UI display
 */
export function getFrontmatterValueType(
  value: FrontmatterValue,
): "text" | "number" | "boolean" | "date" | "tags" | "null" {
  if (value === null) return "null";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "tags";
  return "text";
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
