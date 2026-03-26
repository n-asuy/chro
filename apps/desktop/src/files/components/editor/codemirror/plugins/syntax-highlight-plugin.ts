/**
 * Syntax highlighting styles for markdown content
 * Maps lezer highlight tags to CSS classes
 */

import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
  lezerHighlightEmbed,
  lezerHighlightEmbedMark,
  lezerHighlightInternalDisplay,
  lezerHighlightInternalLink,
  lezerHighlightInternalMark,
  lezerHighlightInternalPath,
  lezerHighlightInternalSubpath,
} from "../lezer-parsers/internal-link-parser";
import {
  lezerHighlightYamlContent,
  lezerHighlightYamlFrontmatter,
  lezerHighlightYamlMarker,
} from "../lezer-parsers/yaml-frontmatter-parser";
import {
  lezerHighlightLatexBlock,
  lezerHighlightLatexInline,
  lezerHighlightLatexMarker,
} from "../lezer-parsers/latex-parser";
import { lezerHighlightIndentation } from "../lezer-parsers/indentation-parser";

export const syntaxHighlightStyles = HighlightStyle.define([
  // Headings
  { tag: t.heading1, class: "cm-heading cm-heading-1", textDecoration: "none" },
  { tag: t.heading2, class: "cm-heading cm-heading-2", textDecoration: "none" },
  { tag: t.heading3, class: "cm-heading cm-heading-3", textDecoration: "none" },
  { tag: t.heading4, class: "cm-heading cm-heading-4", textDecoration: "none" },

  // Links
  { tag: t.link, class: "cm-link" },
  { tag: t.url, class: "cm-link" },

  // Text formatting
  { tag: t.emphasis, class: "cm-emphasis" },
  { tag: t.strong, class: "cm-strong" },
  { tag: t.monospace, class: "cm-mono" },
  { tag: t.strikethrough, class: "cm-strikethrough" },

  // Meta elements
  { tag: t.meta, class: "cm-meta" },
  { tag: t.labelName, class: "cm-meta" },
  { tag: t.escape, class: "cm-escape" },
  { tag: t.contentSeparator, class: "cm-horizontal-rule" },

  // Internal links (Obsidian-style)
  { tag: lezerHighlightEmbed, class: "cm-embed" },
  { tag: lezerHighlightEmbedMark, class: "cm-embed-mark cm-meta" },
  { tag: lezerHighlightInternalLink, class: "cm-internal-link" },
  { tag: lezerHighlightInternalMark, class: "cm-internal-link-mark cm-meta" },
  { tag: lezerHighlightInternalPath, class: "cm-internal-link-path" },
  { tag: lezerHighlightInternalSubpath, class: "cm-internal-link-subpath" },
  { tag: lezerHighlightInternalDisplay, class: "cm-internal-link-display" },

  // YAML frontmatter
  { tag: lezerHighlightYamlFrontmatter, class: "cm-yaml-frontmatter cm-meta" },
  { tag: lezerHighlightYamlMarker, class: "cm-yaml-marker cm-meta" },
  { tag: lezerHighlightYamlContent, class: "cm-yaml-content cm-meta" },

  // LaTeX/Math
  { tag: lezerHighlightLatexBlock, class: "cm-tex-block cm-mono" },
  { tag: lezerHighlightLatexInline, class: "cm-tex-inline cm-mono" },
  { tag: lezerHighlightLatexMarker, class: "cm-tex-marker cm-meta" },

  // Indentation
  { tag: lezerHighlightIndentation, class: "cm-indent" },
]);
