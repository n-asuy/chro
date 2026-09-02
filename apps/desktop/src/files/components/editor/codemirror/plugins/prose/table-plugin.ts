/**
 * Inline table editing plugin
 *
 * Renders markdown tables as interactive HTML tables.
 * Clicking a cell makes it editable in-place (contenteditable).
 * Tab/Shift+Tab navigates cells, Enter moves down / creates rows, Escape exits.
 * Edge +buttons add rows/columns. Right-click opens a context menu.
 * Edits are synced back to the markdown source via CodeMirror transactions.
 */

import { openExternalUrl } from "@/lib/open-external-url";
import { needsDecorationRebuild } from "../decoration-refresh";
import { syntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  type Extension,
  type Range as EditorRange,
  type EditorState,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import {
  appendColumn,
  appendRow,
  deleteColumn,
  deleteRow,
  insertColumnLeft,
  insertColumnRight,
  insertRowAbove,
  insertRowBelow,
  setColumnAlignment,
} from "./table-operations";
import {
  escapeUnescapedTablePipes,
  isEscapedAt,
  splitTableRowCells,
  unescapeTableCellPipes,
} from "./table-cell-utils";
import type { TableCell, TableInfo, TableRow } from "./table-types";

// ─── Parsing ─────────────────────────────────────────────────────────

function parseAlignment(cell: string): "left" | "center" | "right" | undefined {
  const trimmed = cell.trim();
  const hasLeft = trimmed.startsWith(":");
  const hasRight = trimmed.endsWith(":");
  if (hasLeft && hasRight) return "center";
  if (hasRight) return "right";
  if (hasLeft) return "left";
  return undefined;
}

interface TablePluginConfig {
  onInternalLinkClick?: (path: string) => void;
}

interface ParsedInternalLink {
  path: string;
  display: string;
}

interface ParsedExternalLink {
  url: string;
  display: string;
}

type TableInlineSegment =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "internal-link"; link: ParsedInternalLink }
  | { type: "external-link"; link: ParsedExternalLink };

const WIKILINK_PATTERN = /\[\[([\s\S]*?)\]\]/g;
const TABLE_MARKDOWN_LINK_PATTERN =
  /\[([^\]]*)\]\(([^)\s]+)\)|<((?:https?:\/\/)[^>\s]+)>/g;
const TABLE_BOLD_PATTERN = /\*\*([^*\n]+?)\*\*/g;

const normalizeTableExternalUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1)
      : trimmed;
  const lower = normalized.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
    return null;
  }

  return normalized;
};

interface CaretPositionResult {
  offsetNode: Node;
  offset: number;
}

const caretRangeFromPoint = (
  x: number,
  y: number,
  container: HTMLElement,
): Range | null => {
  if (typeof document === "undefined") return null;

  let range: Range | null = null;

  const standardFn = (
    document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => CaretPositionResult | null;
    }
  ).caretPositionFromPoint;
  if (typeof standardFn === "function") {
    const pos = standardFn.call(document, x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  } else if (typeof document.caretRangeFromPoint === "function") {
    range = document.caretRangeFromPoint(x, y);
    if (range) {
      range.collapse(true);
    }
  }

  if (!range) return null;
  if (!container.contains(range.startContainer)) return null;
  return range;
};

function findWikilinkAliasSeparator(rawTarget: string): {
  index: number;
  length: 1 | 2;
} | null {
  for (let i = 0; i < rawTarget.length; i++) {
    if (rawTarget[i] === "|" && !isEscapedAt(rawTarget, i)) {
      return { index: i, length: 1 };
    }
    if (
      rawTarget[i] === "\\" &&
      rawTarget[i + 1] === "|" &&
      !isEscapedAt(rawTarget, i)
    ) {
      return { index: i, length: 2 };
    }
  }
  return null;
}

function parseTableInternalLink(rawTarget: string): ParsedInternalLink | null {
  const separator = findWikilinkAliasSeparator(rawTarget);
  const rawPath = separator
    ? rawTarget.slice(0, separator.index)
    : rawTarget.trim();
  const rawDisplay = separator
    ? rawTarget.slice(separator.index + separator.length)
    : "";

  const unescapedPath = unescapeTableCellPipes(rawPath).trim();
  const hashIndex = unescapedPath.indexOf("#");
  const path =
    hashIndex === -1 ? unescapedPath : unescapedPath.slice(0, hashIndex).trim();

  if (!path) return null;

  const display = rawDisplay
    ? unescapeTableCellPipes(rawDisplay).trim() || path
    : path;

  return { path, display };
}

function parseCellInlineSegments(rawCell: string): TableInlineSegment[] {
  const source = rawCell.trim();
  const wikilinkSegments: TableInlineSegment[] = [];

  if (!source.includes("[[")) {
    wikilinkSegments.push({
      type: "text",
      value: unescapeTableCellPipes(source),
    });
  } else {
    let lastIndex = 0;
    WIKILINK_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = WIKILINK_PATTERN.exec(source)) !== null) {
      if (match.index > lastIndex) {
        wikilinkSegments.push({
          type: "text",
          value: unescapeTableCellPipes(source.slice(lastIndex, match.index)),
        });
      }

      const parsedLink = parseTableInternalLink(match[1] ?? "");
      if (parsedLink) {
        wikilinkSegments.push({ type: "internal-link", link: parsedLink });
      } else {
        wikilinkSegments.push({
          type: "text",
          value: unescapeTableCellPipes(match[0]),
        });
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < source.length) {
      wikilinkSegments.push({
        type: "text",
        value: unescapeTableCellPipes(source.slice(lastIndex)),
      });
    }
  }

  if (wikilinkSegments.length === 0) {
    wikilinkSegments.push({
      type: "text",
      value: unescapeTableCellPipes(source),
    });
  }

  const parsedSegments: TableInlineSegment[] = [];

  for (const segment of wikilinkSegments) {
    if (segment.type !== "text") {
      parsedSegments.push(segment);
      continue;
    }

    const text = segment.value;
    if (
      !text.includes("http://") &&
      !text.includes("https://") &&
      !text.includes("](")
    ) {
      parsedSegments.push(segment);
      continue;
    }

    let textLastIndex = 0;
    TABLE_MARKDOWN_LINK_PATTERN.lastIndex = 0;

    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = TABLE_MARKDOWN_LINK_PATTERN.exec(text)) !== null) {
      if (linkMatch.index > textLastIndex) {
        parsedSegments.push({
          type: "text",
          value: text.slice(textLastIndex, linkMatch.index),
        });
      }

      const markdownDisplay = linkMatch[1];
      const markdownUrl = linkMatch[2];
      const autolinkUrl = linkMatch[3];
      const rawUrl = (markdownUrl ?? autolinkUrl ?? "").trim();
      const isExternal = /^https?:\/\//i.test(rawUrl);

      if (isExternal) {
        const url = normalizeTableExternalUrl(rawUrl);
        if (!url) {
          parsedSegments.push({
            type: "text",
            value: linkMatch[0],
          });
        } else {
          parsedSegments.push({
            type: "external-link",
            link: {
              url,
              display: (markdownDisplay && markdownDisplay.trim()) || url,
            },
          });
        }
      } else if (rawUrl) {
        parsedSegments.push({
          type: "internal-link",
          link: {
            path: rawUrl,
            display: (markdownDisplay && markdownDisplay.trim()) || rawUrl,
          },
        });
      } else {
        parsedSegments.push({
          type: "text",
          value: linkMatch[0],
        });
      }

      textLastIndex = linkMatch.index + linkMatch[0].length;
    }

    if (textLastIndex < text.length) {
      parsedSegments.push({
        type: "text",
        value: text.slice(textLastIndex),
      });
    }
  }

  if (parsedSegments.length === 0) {
    parsedSegments.push({ type: "text", value: unescapeTableCellPipes(source) });
  }

  const withBold: TableInlineSegment[] = [];
  for (const segment of parsedSegments) {
    if (segment.type !== "text" || !segment.value.includes("**")) {
      withBold.push(segment);
      continue;
    }

    const text = segment.value;
    let boldLastIndex = 0;
    TABLE_BOLD_PATTERN.lastIndex = 0;

    let boldMatch: RegExpExecArray | null;
    let matched = false;
    while ((boldMatch = TABLE_BOLD_PATTERN.exec(text)) !== null) {
      matched = true;
      if (boldMatch.index > boldLastIndex) {
        withBold.push({
          type: "text",
          value: text.slice(boldLastIndex, boldMatch.index),
        });
      }
      withBold.push({ type: "bold", value: boldMatch[1] });
      boldLastIndex = boldMatch.index + boldMatch[0].length;
    }

    if (!matched) {
      withBold.push(segment);
      continue;
    }

    if (boldLastIndex < text.length) {
      withBold.push({ type: "text", value: text.slice(boldLastIndex) });
    }
  }

  return withBold;
}

function findTables(state: EditorState): TableInfo[] {
  const tables: TableInfo[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Table") {
        const rows: TableRow[] = [];
        let alignments: ("left" | "center" | "right" | undefined)[] = [];
        let headerFound = false;
        let delimiterFound = false;

        let child = node.node.firstChild;
        while (child) {
          // Lezer emits TableHeader for the header row, TableRow for body rows,
          // and a top-level TableDelimiter for the `| --- | --- |` line.
          // The delimiter line is NOT a TableRow, so we must handle it explicitly.
          const isTableRow =
            child.name === "TableRow" || child.name === "TableHeader";
          const isTopLevelDelimiter =
            child.name === "TableDelimiter" && !delimiterFound;

          // Skip inline TableDelimiter nodes (pipe separators inside rows)
          // which are short fragments, not full-line delimiters.
          const childText = state.doc.sliceString(child.from, child.to);
          const isFullLineDelimiter =
            isTopLevelDelimiter && /^[\s|:\-]+$/.test(childText);

          if (isTableRow || isFullLineDelimiter) {
            const isHeader =
              child.name === "TableHeader" || (!headerFound && !delimiterFound);
            const rowText = childText;
            const cells: TableCell[] = splitTableRowCells(
              rowText,
              child.from,
            ).map((cell) => ({
              ...cell,
              isHeader: isHeader && !isFullLineDelimiter,
            }));

            const isDelimiter =
              isFullLineDelimiter ||
              (/^[\s|:\-]+$/.test(rowText) && rowText.includes("-"));

            if (isDelimiter && !delimiterFound) {
              delimiterFound = true;
              alignments = cells.map((c) => parseAlignment(c.content));
            }

            rows.push({
              cells,
              from: child.from,
              to: child.to,
              isHeader: isHeader && !isDelimiter,
              isDelimiter,
            });

            if (isHeader && !isDelimiter) {
              headerFound = true;
            }
          }
          child = child.nextSibling;
        }

        if (rows.length > 0) {
          tables.push({ rows, from: node.from, to: node.to, alignments });
        }
      }
    },
  });

  return tables;
}

// ─── Context menu ────────────────────────────────────────────────────

interface ContextMenuItem {
  type: "item" | "separator";
  label?: string;
  action?: () => void;
  disabled?: boolean;
}

let activeContextMenu: HTMLElement | null = null;
let contextMenuCleanup: (() => void) | null = null;

function hideContextMenu() {
  activeContextMenu?.remove();
  activeContextMenu = null;
  contextMenuCleanup?.();
  contextMenuCleanup = null;
}

function showContextMenu(x: number, y: number, items: ContextMenuItem[]) {
  hideContextMenu();

  const menu = document.createElement("div");
  menu.className = "cm-table-context-menu";

  for (const item of items) {
    if (item.type === "separator") {
      const sep = document.createElement("div");
      sep.className = "cm-table-context-menu-separator";
      menu.appendChild(sep);
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-table-context-menu-item";
    if (item.disabled) {
      btn.disabled = true;
      btn.classList.add("cm-table-context-menu-item-disabled");
    }
    btn.textContent = item.label ?? "";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
      item.action?.();
    });
    menu.appendChild(btn);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Clamp to viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  });

  activeContextMenu = menu;

  const onClickOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      hideContextMenu();
    }
  };
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      hideContextMenu();
    }
  };
  const onScroll = () => hideContextMenu();

  // Delay attachment to avoid immediately closing from the contextmenu event
  requestAnimationFrame(() => {
    document.addEventListener("click", onClickOutside, true);
    document.addEventListener("contextmenu", onClickOutside, true);
    document.addEventListener("keydown", onEscape);
    document.addEventListener("scroll", onScroll, true);
  });

  contextMenuCleanup = () => {
    document.removeEventListener("click", onClickOutside, true);
    document.removeEventListener("contextmenu", onClickOutside, true);
    document.removeEventListener("keydown", onEscape);
    document.removeEventListener("scroll", onScroll, true);
  };
}

// ─── Editable table widget ──────────────────────────────────────────

/**
 * Store the currently active editing widget so that only one table is
 * in "cell edit" mode at a time.
 */
let activeTableWidget: EditableTableWidget | null = null;

class EditableTableWidget extends WidgetType {
  private activeCellEl: HTMLElement | null = null;
  private activeCellRow = -1;
  private activeCellCol = -1;
  private cellElements: HTMLElement[][] = [];
  private containerEl: HTMLElement | null = null;
  private view: EditorView | null = null;

  constructor(
    private table: TableInfo,
    private nodeFrom: number,
    private config: TablePluginConfig,
  ) {
    super();
  }

  // ── DOM construction ────────────────────────────────────────────

  toDOM(view: EditorView): HTMLElement {
    this.view = view;

    const container = document.createElement("div");
    container.className = "cm-table-container cm-table-inline-edit";
    this.containerEl = container;

    const tableEl = document.createElement("table");
    tableEl.className = "cm-table";

    this.cellElements = [];

    // Header
    const headerRows = this.table.rows.filter((r) => r.isHeader);
    if (headerRows.length > 0) {
      const thead = document.createElement("thead");
      for (const row of headerRows) {
        const tr = document.createElement("tr");
        const cellEls: HTMLElement[] = [];
        row.cells.forEach((cell, colIdx) => {
          const th = document.createElement("th");
          this.renderCellDisplay(th, cell.content);
          this.applyAlign(th, colIdx);
          this.attachCellHandlers(th, this.cellElements.length, colIdx);
          tr.appendChild(th);
          cellEls.push(th);
        });
        thead.appendChild(tr);
        this.cellElements.push(cellEls);
      }
      tableEl.appendChild(thead);
    }

    // Body (skip delimiter rows)
    const bodyRows = this.table.rows.filter(
      (r) => !r.isHeader && !r.isDelimiter,
    );
    if (bodyRows.length > 0) {
      const tbody = document.createElement("tbody");
      for (const row of bodyRows) {
        const tr = document.createElement("tr");
        const cellEls: HTMLElement[] = [];
        row.cells.forEach((cell, colIdx) => {
          const td = document.createElement("td");
          this.renderCellDisplay(td, cell.content);
          this.applyAlign(td, colIdx);
          this.attachCellHandlers(td, this.cellElements.length, colIdx);
          tr.appendChild(td);
          cellEls.push(td);
        });
        tbody.appendChild(tr);
        this.cellElements.push(cellEls);
      }
      tableEl.appendChild(tbody);
    }

    // Horizontal scroll wrapper: when the editor pane is narrower than the
    // table's natural width, this scrolls instead of squeezing columns.
    // It lives inside the container so the edge +buttons (which need
    // `overflow: visible`) stay clickable on the outer element.
    const scroll = document.createElement("div");
    scroll.className = "cm-table-scroll";
    scroll.appendChild(tableEl);
    container.appendChild(scroll);

    // ── Edge +buttons ──────────────────────────────────────────
    this.appendEdgeButtons(container);

    return container;
  }

  // ── Edge +buttons ──────────────────────────────────────────────

  private appendEdgeButtons(container: HTMLElement) {
    const makeBtn = (className: string, label: string, action: () => void) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = className;
      btn.setAttribute("aria-label", label);
      btn.textContent = "+";
      // Use capture phase to intercept before CodeMirror's handlers
      btn.addEventListener(
        "mousedown",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        },
        true,
      );
      btn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          this.commitAndDeactivate();
          action();
        },
        true,
      );
      // Also attach on bubble phase as fallback
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      return btn;
    };

    container.appendChild(
      makeBtn("cm-table-add-col-btn", "Add column", () =>
        this.applyStructuralChange(appendColumn(this.table)),
      ),
    );
    container.appendChild(
      makeBtn("cm-table-add-row-btn", "Add row", () =>
        this.applyStructuralChange(appendRow(this.table)),
      ),
    );
  }

  // ── Structural changes ─────────────────────────────────────────

  private applyStructuralChange(changes: ChangeSpec[] | null) {
    if (!changes || changes.length === 0 || !this.view) return;
    // Clear active widget so the decoration field fully rebuilds
    if (activeTableWidget === this) {
      activeTableWidget = null;
    }
    this.view.dispatch({ changes });
  }

  // ── Alignment helper ────────────────────────────────────────────

  private applyAlign(el: HTMLElement, colIdx: number) {
    const align = this.table.alignments[colIdx];
    if (align) {
      el.style.textAlign = align;
    }
  }

  private renderCellDisplay(el: HTMLElement, rawContent: string) {
    const normalizedRaw = rawContent.trim();
    el.dataset.rawContent = normalizedRaw;
    el.textContent = "";

    const segments = parseCellInlineSegments(normalizedRaw);
    for (const segment of segments) {
      if (segment.type === "text") {
        el.appendChild(document.createTextNode(segment.value));
        continue;
      }

      if (segment.type === "bold") {
        const boldEl = document.createElement("strong");
        boldEl.textContent = segment.value;
        el.appendChild(boldEl);
        continue;
      }

      if (segment.type === "external-link") {
        const linkEl = document.createElement("span");
        linkEl.className = "cm-table-external-link";
        linkEl.textContent = segment.link.display;
        linkEl.setAttribute("data-link-url", segment.link.url);
        linkEl.setAttribute("title", segment.link.url);
        linkEl.addEventListener("click", (event) => {
          const isPrimaryButton = event.button === 0;
          const hasNavigationModifiers =
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey;

          if (isPrimaryButton && hasNavigationModifiers) {
            event.preventDefault();
            event.stopPropagation();
            openExternalUrl(segment.link.url);
          }
        });
        el.appendChild(linkEl);
        continue;
      }

      const linkEl = document.createElement("span");
      linkEl.className = "cm-table-internal-link";
      linkEl.textContent = segment.link.display;
      linkEl.setAttribute("data-link-path", segment.link.path);
      linkEl.setAttribute("title", segment.link.path);
      linkEl.addEventListener("click", (event) => {
        const isPrimaryButton = event.button === 0;
        const hasNavigationModifiers =
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey;

        if (
          isPrimaryButton &&
          hasNavigationModifiers &&
          this.config.onInternalLinkClick
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.config.onInternalLinkClick(segment.link.path);
        }
      });
      el.appendChild(linkEl);
    }
  }

  private getCellRawContent(rowIdx: number, colIdx: number): string {
    const currentCell = this.cellElements[rowIdx]?.[colIdx];
    const cached = currentCell?.dataset.rawContent;
    if (typeof cached === "string") return cached;

    const editableRows = this.table.rows.filter((r) => !r.isDelimiter);
    const row = editableRows[rowIdx];
    const cell = row?.cells[colIdx];
    return cell?.content.trim() ?? "";
  }

  // ── Cell interaction ────────────────────────────────────────────

  private attachCellHandlers(el: HTMLElement, rowIdx: number, colIdx: number) {
    el.style.cursor = "text";

    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startEditingCell(rowIdx, colIdx, {
        x: e.clientX,
        y: e.clientY,
      });
    });

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showCellContextMenu(e.clientX, e.clientY, rowIdx, colIdx);
    });
  }

  // ── Context menu ───────────────────────────────────────────────

  private showCellContextMenu(
    x: number,
    y: number,
    rowIdx: number,
    colIdx: number,
  ) {
    const visibleRowCount = this.cellElements.length;
    const headerRowCount = this.table.rows.filter((r) => r.isHeader).length;
    const bodyRowCount = visibleRowCount - headerRowCount;
    const colCount = this.cellElements[0]?.length ?? 0;
    const isHeader = rowIdx < headerRowCount;

    const items: ContextMenuItem[] = [
      {
        type: "item",
        label: "Edit as raw text",
        action: () => {
          this.enterRawEdit();
        },
      },
      { type: "separator" },
      {
        type: "item",
        label: "Insert row above",
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(insertRowAbove(this.table, rowIdx));
        },
      },
      {
        type: "item",
        label: "Insert row below",
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(insertRowBelow(this.table, rowIdx));
        },
      },
      { type: "separator" },
      {
        type: "item",
        label: "Insert column left",
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(insertColumnLeft(this.table, colIdx));
        },
      },
      {
        type: "item",
        label: "Insert column right",
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(insertColumnRight(this.table, colIdx));
        },
      },
      { type: "separator" },
      {
        type: "item",
        label: "Delete row",
        disabled: isHeader || bodyRowCount <= 1,
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(deleteRow(this.table, rowIdx));
        },
      },
      {
        type: "item",
        label: "Delete column",
        disabled: colCount <= 1,
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(deleteColumn(this.table, colIdx));
        },
      },
      { type: "separator" },
      {
        type: "item",
        label: "Align left",
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(
            setColumnAlignment(this.table, colIdx, "left"),
          );
        },
      },
      {
        type: "item",
        label: "Align center",
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(
            setColumnAlignment(this.table, colIdx, "center"),
          );
        },
      },
      {
        type: "item",
        label: "Align right",
        action: () => {
          this.commitAndDeactivate();
          this.applyStructuralChange(
            setColumnAlignment(this.table, colIdx, "right"),
          );
        },
      },
    ];

    showContextMenu(x, y, items);
  }

  // ── Cell editing ───────────────────────────────────────────────

  private startEditingCell(
    rowIdx: number,
    colIdx: number,
    caretAt?: { x: number; y: number },
  ) {
    // Commit any previously active cell first
    if (this.activeCellEl) {
      this.commitActiveCell();
    }

    // Deactivate any other table widget
    if (activeTableWidget && activeTableWidget !== this) {
      activeTableWidget.commitAndDeactivate();
    }
    activeTableWidget = this;

    const el = this.cellElements[rowIdx]?.[colIdx];
    if (!el) return;

    this.activeCellEl = el;
    this.activeCellRow = rowIdx;
    this.activeCellCol = colIdx;

    const rawContent = this.getCellRawContent(rowIdx, colIdx);
    el.textContent = rawContent;
    el.setAttribute("contenteditable", "true");
    el.classList.add("cm-table-cell-active");
    el.focus();

    const sel = window.getSelection();
    sel?.removeAllRanges();

    const caretRange = caretAt
      ? caretRangeFromPoint(caretAt.x, caretAt.y, el)
      : null;
    if (caretRange) {
      sel?.addRange(caretRange);
    } else {
      // Keyboard navigation (Tab/Enter) or unsupported caret API:
      // place cursor at the end so typing appends.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.addRange(range);
    }

    // Keyboard handlers on the cell
    el.addEventListener("keydown", this.handleCellKeydown);
    el.addEventListener("blur", this.handleCellBlur);
  }

  private handleCellKeydown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Tab": {
        e.preventDefault();
        e.stopPropagation();
        this.commitActiveCell();
        if (e.shiftKey) {
          this.moveToPrevCell();
        } else {
          this.moveToNextCell();
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        e.stopPropagation();
        this.commitActiveCell();
        this.moveToNextRow();
        break;
      }
      case "Escape": {
        e.preventDefault();
        e.stopPropagation();
        this.commitAndDeactivate();
        // Return focus to the CodeMirror editor, place cursor after table
        if (this.view) {
          const pos = Math.min(this.table.to, this.view.state.doc.length);
          this.view.dispatch({ selection: { anchor: pos } });
          this.view.focus();
        }
        break;
      }
    }
  };

  private handleCellBlur = (e: FocusEvent) => {
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    // If focus is moving to another cell in the same table, don't commit yet —
    // the click handler on the next cell will handle the transition.
    if (relatedTarget && this.containerEl?.contains(relatedTarget)) {
      return;
    }
    // Focus left the table entirely: commit changes.
    this.commitAndDeactivate();
  };

  // ── Navigation ──────────────────────────────────────────────────

  private moveToNextCell() {
    const totalRows = this.cellElements.length;
    if (totalRows === 0) return;

    let row = this.activeCellRow;
    let col = this.activeCellCol + 1;
    const colCount = this.cellElements[0].length;

    if (col >= colCount) {
      col = 0;
      row += 1;
    }
    if (row >= totalRows) {
      // At the last cell — add a new row
      this.addNewRow();
      row = totalRows; // will be the newly added row
      col = 0;
    }
    this.startEditingCell(row, col);
  }

  private moveToPrevCell() {
    let row = this.activeCellRow;
    let col = this.activeCellCol - 1;
    const colCount = this.cellElements[0]?.length ?? 0;

    if (col < 0) {
      col = colCount - 1;
      row -= 1;
    }
    if (row < 0) {
      row = 0;
      col = 0;
    }
    this.startEditingCell(row, col);
  }

  private moveToNextRow() {
    const totalRows = this.cellElements.length;
    let row = this.activeCellRow + 1;
    const col = this.activeCellCol;

    if (row >= totalRows) {
      this.addNewRow();
      row = totalRows;
    }
    this.startEditingCell(row, col);
  }

  // ── Row creation ────────────────────────────────────────────────

  private addNewRow() {
    if (!this.view) return;

    const colCount = this.cellElements[0]?.length ?? 0;
    const emptyCells = Array(colCount).fill("  ");
    const newRowMarkdown = `\n| ${emptyCells.join(" | ")} |`;

    // Insert at the end of the table
    this.view.dispatch({
      changes: { from: this.table.to, insert: newRowMarkdown },
    });

    // The decoration field will rebuild; however, because the widget is
    // block-replacing the whole table range, we need to reconstruct
    // the DOM row ourselves for immediate visual feedback.
    const tbody =
      this.containerEl?.querySelector("tbody") ?? this.createTbody();

    const tr = document.createElement("tr");
    const cellEls: HTMLElement[] = [];
    for (let c = 0; c < colCount; c++) {
      const td = document.createElement("td");
      this.renderCellDisplay(td, "");
      td.style.cursor = "text";
      this.applyAlign(td, c);
      const rowIdx = this.cellElements.length;
      this.attachCellHandlers(td, rowIdx, c);
      tr.appendChild(td);
      cellEls.push(td);
    }
    tbody.appendChild(tr);
    this.cellElements.push(cellEls);
  }

  private createTbody(): HTMLElement {
    const tableEl = this.containerEl?.querySelector("table");
    if (!tableEl) throw new Error("table element missing");
    const tbody = document.createElement("tbody");
    tableEl.appendChild(tbody);
    return tbody;
  }

  // ── Commit ──────────────────────────────────────────────────────

  /**
   * Write the current cell's contenteditable text back to the markdown source.
   */
  private commitActiveCell() {
    const el = this.activeCellEl;
    if (!el || !this.view) return;

    const newText = el.textContent ?? "";
    const row = this.activeCellRow;
    const col = this.activeCellCol;

    // Clean up DOM state
    el.removeAttribute("contenteditable");
    el.classList.remove("cm-table-cell-active");
    el.removeEventListener("keydown", this.handleCellKeydown);
    el.removeEventListener("blur", this.handleCellBlur);

    // Map visual row index to actual TableRow (skip delimiter rows)
    const editableRows = this.table.rows.filter((r) => !r.isDelimiter);
    const tableRow = editableRows[row];
    if (!tableRow) return;

    const cell = tableRow.cells[col];
    if (!cell) return;

    // Only dispatch if the content actually changed
    const oldTrimmed = cell.content.trim();
    const newTrimmed = newText.trim();
    const newEscaped = escapeUnescapedTablePipes(newTrimmed);

    this.renderCellDisplay(el, newEscaped);

    if (oldTrimmed === newEscaped) {
      this.activeCellEl = null;
      this.activeCellRow = -1;
      this.activeCellCol = -1;
      return;
    }

    // Replace the cell content in the markdown source.
    // Preserve surrounding spaces: replace the content between `from` and `to`
    // with the new text padded to at least the same width.
    const newPadded = ` ${newEscaped} `;
    this.view.dispatch({
      changes: { from: cell.from, to: cell.to, insert: newPadded },
    });

    this.activeCellEl = null;
    this.activeCellRow = -1;
    this.activeCellCol = -1;
  }

  commitAndDeactivate() {
    this.commitActiveCell();
    if (activeTableWidget === this) {
      activeTableWidget = null;
    }
  }

  // ── Raw editing ─────────────────────────────────────────────────

  /**
   * Drop the rendered widget for this table and place the cursor in its
   * Markdown source so it can be edited as raw text. The table re-renders
   * automatically once the selection leaves the source (see `rawEditField`).
   */
  private enterRawEdit() {
    if (!this.view) return;
    this.commitAndDeactivate();

    const docLength = this.view.state.doc.length;
    const from = Math.min(this.table.from, docLength);
    const to = Math.min(this.table.to, docLength);

    this.view.dispatch({
      effects: enterRawEditEffect.of({ from, to }),
      selection: { anchor: from },
    });
    this.view.focus();
  }

  // ── Widget protocol ─────────────────────────────────────────────

  eq(other: EditableTableWidget): boolean {
    if (this.activeCellEl) return true; // don't replace while editing
    return (
      this.nodeFrom === other.nodeFrom &&
      this.table.from === other.table.from &&
      this.table.to === other.table.to &&
      this.table.rows.length === other.table.rows.length &&
      (this.table.rows[0]?.cells.length ?? 0) ===
        (other.table.rows[0]?.cells.length ?? 0)
    );
  }

  get estimatedHeight(): number {
    return 40 + this.table.rows.length * 32;
  }

  destroy() {
    this.commitAndDeactivate();
    this.containerEl = null;
    this.view = null;
  }
}

// ─── Raw edit state ──────────────────────────────────────────────────

/**
 * When a table is in "raw edit" mode the block widget is suppressed for that
 * range so the user can edit the underlying Markdown source directly, with no
 * rendering. The range is mapped through edits and cleared automatically once
 * the selection leaves it, at which point the table re-renders.
 */
interface RawEditRange {
  from: number;
  to: number;
}

const enterRawEditEffect = StateEffect.define<RawEditRange>();

const rawEditField = StateField.define<RawEditRange | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(enterRawEditEffect)) {
        return effect.value;
      }
    }
    if (!value) {
      return value;
    }
    // Map the tracked range through the edit and keep it only while the
    // selection stays inside; clicking/typing outside exits raw mode.
    const from = tr.changes.mapPos(value.from, -1);
    const to = tr.changes.mapPos(value.to, 1);
    if (tr.selection) {
      const head = tr.selection.main.head;
      if (head < from || head > to) {
        return null;
      }
    }
    if (from === value.from && to === value.to) {
      return value;
    }
    return { from, to };
  },
});

// ─── Decoration field ────────────────────────────────────────────────

function buildTableDecorations(
  state: EditorState,
  config: TablePluginConfig,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const tables = findTables(state);
  const rawEdit = state.field(rawEditField, false) ?? null;

  for (const table of tables) {
    // Skip the table currently being edited as raw Markdown so its source
    // stays visible and editable instead of being replaced by the widget.
    if (rawEdit && table.from <= rawEdit.to && table.to >= rawEdit.from) {
      continue;
    }
    decorations.push(
      Decoration.replace({
        widget: new EditableTableWidget(table, table.from, config),
        block: true,
      }).range(table.from, table.to),
    );
  }

  return decorations;
}

export function createTablePlugin(config: TablePluginConfig = {}): Extension {
  const tableDecorationField = StateField.define<DecorationSet>({
    create(state) {
      return RangeSet.of(buildTableDecorations(state, config), true);
    },
    update(value, tr) {
      // Entering/leaving raw-edit mode adds or removes a table's widget, so we
      // must rebuild whenever that state changes, even on a bare selection
      // move (no doc change, no effect) that causes raw mode to auto-exit.
      const rawChanged =
        tr.startState.field(rawEditField, false) !==
        tr.state.field(rawEditField, false);
      // When a cell is being edited inside the widget, doc changes come from
      // the widget's commit. We must rebuild decorations so table positions
      // stay correct, but only if no cell is actively being edited (to avoid
      // destroying the widget mid-edit).
      if (activeTableWidget && !rawChanged) {
        // If the document changed (our own commit), remap positions
        if (tr.docChanged) {
          return value.map(tr.changes);
        }
        return value;
      }
      if (tr.docChanged || needsDecorationRebuild(tr) || rawChanged) {
        return RangeSet.of(buildTableDecorations(tr.state, config), true);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [rawEditField, tableDecorationField];
}

// ─── Export ──────────────────────────────────────────────────────────

export const tablePlugin = createTablePlugin();
