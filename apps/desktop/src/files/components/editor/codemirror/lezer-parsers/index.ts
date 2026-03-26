/**
 * Custom OFM (Obsidian Flavored Markdown) parsers
 * Combines all lezer parsers into a single array for easy import
 */

import { Strikethrough, Table } from "@lezer/markdown";
import {
  InternalLink,
  Mark,
  Comment,
  Footnote,
  TaskList,
  Tex,
} from "lezer-markdown-obsidian";

import { hashtagParser } from "./hashtag-parser";
import { internalLinkParser } from "./internal-link-parser";
import { latexParser } from "./latex-parser";
import { yamlFrontmatterParser } from "./yaml-frontmatter-parser";
import { calloutParser } from "./callout-parser";
import { indentationParser } from "./indentation-parser";

// Export individual parsers
export { hashtagParser } from "./hashtag-parser";
export { internalLinkParser } from "./internal-link-parser";
export { latexParser } from "./latex-parser";
export { yamlFrontmatterParser } from "./yaml-frontmatter-parser";
export { calloutParser } from "./callout-parser";
export { indentationParser } from "./indentation-parser";

/**
 * Combined array of all custom OFM parsers
 * Note: The array must remain implicit because the version of @lezer/markdown
 * that lezer-markdown-obsidian uses may differ from this project's version.
 */
export const customOFMParsers = [
  Comment,
  Footnote,
  hashtagParser,
  internalLinkParser,
  Mark,
  Strikethrough,
  Table,
  TaskList,
  latexParser,
  yamlFrontmatterParser,
  calloutParser,
  indentationParser,
];

// Re-export useful types from lezer-markdown-obsidian
export { InternalLink, Mark, Comment, Footnote, TaskList, Tex };
