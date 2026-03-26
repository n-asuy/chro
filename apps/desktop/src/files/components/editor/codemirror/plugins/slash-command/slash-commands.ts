/**
 * Slash command definitions for the markdown editor
 */

import type { EditorView } from "@codemirror/view";

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  icon?: string;
  keywords: string[];
  execute: (view: EditorView) => void;
}

/**
 * Insert text at the current cursor position, replacing the slash command trigger
 */
function insertBlock(
  view: EditorView,
  text: string,
  cursorOffset?: number,
): void {
  const { state } = view;
  const pos = state.selection.main.head;

  // Find the start of the slash command (search backwards for "/")
  const line = state.doc.lineAt(pos);
  const lineText = line.text.slice(0, pos - line.from);
  const slashIndex = lineText.lastIndexOf("/");

  if (slashIndex === -1) return;

  const from = line.from + slashIndex;
  const to = pos;

  view.dispatch({
    changes: { from, to, insert: text },
    selection: {
      anchor: from + (cursorOffset ?? text.length),
    },
  });

  view.focus();
}

/**
 * Insert a block element, ensuring it starts on a new line
 */
function insertBlockElement(
  view: EditorView,
  text: string,
  cursorOffset?: number,
): void {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const lineText = line.text.slice(0, pos - line.from);
  const slashIndex = lineText.lastIndexOf("/");

  // Check if there's content before the slash on this line
  const contentBeforeSlash =
    slashIndex > 0 ? lineText.slice(0, slashIndex).trim() : "";

  let insertText = text;
  let additionalOffset = 0;

  if (contentBeforeSlash) {
    // Add newline before the block
    insertText = `\n${text}`;
    additionalOffset = 1;
  }

  const from = line.from + (slashIndex === -1 ? 0 : slashIndex);
  const to = pos;

  view.dispatch({
    changes: { from, to, insert: insertText },
    selection: {
      anchor: from + additionalOffset + (cursorOffset ?? text.length),
    },
  });

  view.focus();
}

export const slashCommands: SlashCommand[] = [
  // Headings
  {
    id: "h1",
    label: "Heading 1",
    description: "Large section heading",
    icon: "H1",
    keywords: ["heading", "h1", "title", "large"],
    execute: (view) => insertBlockElement(view, "# ", 2),
  },
  {
    id: "h2",
    label: "Heading 2",
    description: "Medium section heading",
    icon: "H2",
    keywords: ["heading", "h2", "subtitle", "medium"],
    execute: (view) => insertBlockElement(view, "## ", 3),
  },
  {
    id: "h3",
    label: "Heading 3",
    description: "Small section heading",
    icon: "H3",
    keywords: ["heading", "h3", "small"],
    execute: (view) => insertBlockElement(view, "### ", 4),
  },
  {
    id: "h4",
    label: "Heading 4",
    description: "Sub-section heading",
    icon: "H4",
    keywords: ["heading", "h4"],
    execute: (view) => insertBlockElement(view, "#### ", 5),
  },
  {
    id: "h5",
    label: "Heading 5",
    description: "Minor heading",
    icon: "H5",
    keywords: ["heading", "h5"],
    execute: (view) => insertBlockElement(view, "##### ", 6),
  },
  {
    id: "h6",
    label: "Heading 6",
    description: "Smallest heading",
    icon: "H6",
    keywords: ["heading", "h6"],
    execute: (view) => insertBlockElement(view, "###### ", 7),
  },

  // Lists
  {
    id: "list",
    label: "Bullet List",
    description: "Unordered list item",
    icon: "List",
    keywords: ["list", "bullet", "ul", "unordered"],
    execute: (view) => insertBlockElement(view, "- ", 2),
  },
  {
    id: "numbered",
    label: "Numbered List",
    description: "Ordered list item",
    icon: "ListOrdered",
    keywords: ["numbered", "ordered", "ol", "number", "1"],
    execute: (view) => insertBlockElement(view, "1. ", 3),
  },
  {
    id: "task",
    label: "Task",
    description: "Checkbox task item",
    icon: "CheckSquare",
    keywords: ["task", "todo", "checkbox", "check"],
    execute: (view) => insertBlockElement(view, "- [ ] ", 6),
  },

  // Quote and callout
  {
    id: "quote",
    label: "Quote",
    description: "Block quote",
    icon: "Quote",
    keywords: ["quote", "blockquote", "citation"],
    execute: (view) => insertBlockElement(view, "> ", 2),
  },
  {
    id: "callout",
    label: "Callout",
    description: "Highlighted callout box",
    icon: "AlertCircle",
    keywords: ["callout", "note", "warning", "info", "tip"],
    execute: (view) => insertBlockElement(view, "> [!note]\n> ", 12),
  },

  // Code
  {
    id: "code",
    label: "Code Block",
    description: "Fenced code block",
    icon: "Code",
    keywords: ["code", "codeblock", "fence", "pre"],
    execute: (view) => insertBlockElement(view, "```\n\n```", 4),
  },

  // Table
  {
    id: "table",
    label: "Table",
    description: "Markdown table",
    icon: "Table",
    keywords: ["table", "grid"],
    execute: (view) =>
      insertBlockElement(
        view,
        "| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n| Cell 1   | Cell 2   | Cell 3   |",
        2,
      ),
  },

  // Math
  {
    id: "math",
    label: "Math Block",
    description: "LaTeX math equation",
    icon: "Calculator",
    keywords: ["math", "latex", "equation", "formula"],
    execute: (view) => insertBlockElement(view, "$$\n\n$$", 3),
  },

  // Mermaid
  {
    id: "mermaid",
    label: "Mermaid Diagram",
    description: "Mermaid diagram block",
    icon: "GitBranch",
    keywords: ["mermaid", "diagram", "flowchart", "graph"],
    execute: (view) =>
      insertBlockElement(
        view,
        "```mermaid\nflowchart TD\n    A --> B\n```",
        20,
      ),
  },

  // Horizontal rule
  {
    id: "hr",
    label: "Horizontal Rule",
    description: "Divider line",
    icon: "Minus",
    keywords: ["hr", "horizontal", "rule", "divider", "line"],
    execute: (view) => insertBlockElement(view, "---\n", 4),
  },

  // Links and embeds
  {
    id: "link",
    label: "Link",
    description: "External link",
    icon: "Link",
    keywords: ["link", "url", "href"],
    execute: (view) => insertBlock(view, "[](url)", 1),
  },
  {
    id: "image",
    label: "Image",
    description: "Markdown image",
    icon: "Image",
    keywords: ["image", "img", "picture", "photo"],
    execute: (view) => insertBlock(view, "![]()", 2),
  },
  {
    id: "wikilink",
    label: "Internal Link",
    description: "Wiki-style internal link",
    icon: "FileText",
    keywords: ["wikilink", "internal", "wiki", "note"],
    execute: (view) => insertBlock(view, "[[]]", 2),
  },
  {
    id: "embed",
    label: "Embed",
    description: "Embed file or note",
    icon: "FileImage",
    keywords: ["embed", "include", "transclude"],
    execute: (view) => insertBlock(view, "![[]]", 3),
  },
];

/**
 * Filter commands based on search query
 */
export function filterCommands(query: string): SlashCommand[] {
  if (!query) return slashCommands;

  const lowerQuery = query.toLowerCase();
  return slashCommands.filter(
    (cmd) =>
      cmd.id.toLowerCase().includes(lowerQuery) ||
      cmd.label.toLowerCase().includes(lowerQuery) ||
      cmd.keywords.some((kw) => kw.includes(lowerQuery)),
  );
}
