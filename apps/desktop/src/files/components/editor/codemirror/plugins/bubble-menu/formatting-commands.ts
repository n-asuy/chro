/**
 * Markdown formatting commands for CodeMirror 6
 *
 * Provides functions to apply markdown formatting to selected text.
 */

import type { EditorView } from "@codemirror/view";

/**
 * Check if markers exist around the selection (outside the selected text)
 */
function countAdjacentMarkers(
  state: {
    doc: { sliceString: (from: number, to: number) => string; length: number };
  },
  start: number,
  direction: "left" | "right",
  markerChar: string,
): number {
  let count = 0;
  let cursor = direction === "left" ? start - 1 : start;

  while (cursor >= 0 && cursor < state.doc.length) {
    const char = state.doc.sliceString(cursor, cursor + 1);
    if (char !== markerChar) {
      break;
    }
    count += 1;
    cursor = direction === "left" ? cursor - 1 : cursor + 1;
  }

  return count;
}

function hasStarMarkersAround(
  state: {
    doc: { sliceString: (from: number, to: number) => string; length: number };
  },
  from: number,
  to: number,
  markerLength: number,
): boolean {
  const leftCount = countAdjacentMarkers(state, from, "left", "*");
  const rightCount = countAdjacentMarkers(state, to, "right", "*");

  if (markerLength === 1) {
    return (
      leftCount >= 1 &&
      rightCount >= 1 &&
      leftCount % 2 === 1 &&
      rightCount % 2 === 1
    );
  }

  return leftCount >= markerLength && rightCount >= markerLength;
}

function hasMarkersAround(
  state: {
    doc: { sliceString: (from: number, to: number) => string; length: number };
  },
  from: number,
  to: number,
  marker: string,
): boolean {
  const markerLen = marker.length;

  if (marker === "*" || marker === "**") {
    return hasStarMarkersAround(state, from, to, markerLen);
  }

  // Check if there's enough space for markers
  if (from < markerLen || to + markerLen > state.doc.length) {
    return false;
  }

  const beforeMarker = state.doc.sliceString(from - markerLen, from);
  const afterMarker = state.doc.sliceString(to, to + markerLen);

  return beforeMarker === marker && afterMarker === marker;
}

/**
 * Wrap selected text with a markdown marker, or unwrap if already wrapped
 */
function wrapSelection(view: EditorView, marker: string): boolean {
  const { state } = view;
  const selection = state.selection.main;

  if (selection.empty) {
    return false;
  }

  const markerLen = marker.length;

  // Check if markers exist around the selection (outside)
  if (hasMarkersAround(state, selection.from, selection.to, marker)) {
    // Remove the markers from outside the selection
    const selectedText = state.doc.sliceString(selection.from, selection.to);
    view.dispatch({
      changes: {
        from: selection.from - markerLen,
        to: selection.to + markerLen,
        insert: selectedText,
      },
      selection: {
        anchor: selection.from - markerLen,
        head: selection.to - markerLen,
      },
    });
  } else {
    // Add markers around the selection
    const selectedText = state.doc.sliceString(selection.from, selection.to);
    const wrapped = `${marker}${selectedText}${marker}`;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: wrapped },
      selection: {
        anchor: selection.from + markerLen,
        head: selection.to + markerLen,
      },
    });
  }

  return true;
}

/**
 * Toggle bold formatting (**text**)
 */
export function toggleBold(view: EditorView): boolean {
  return wrapSelection(view, "**");
}

/**
 * Toggle italic formatting (*text* or _text_)
 */
export function toggleItalic(view: EditorView): boolean {
  return wrapSelection(view, "*");
}

/**
 * Toggle strikethrough formatting (~~text~~)
 */
export function toggleStrikethrough(view: EditorView): boolean {
  return wrapSelection(view, "~~");
}

/**
 * Toggle inline code formatting (`text`)
 */
export function toggleCode(view: EditorView): boolean {
  return wrapSelection(view, "`");
}

/**
 * Toggle highlight/mark formatting (==text==)
 */
export function toggleHighlight(view: EditorView): boolean {
  return wrapSelection(view, "==");
}

/**
 * Create a link from selected text
 */
export function insertLink(view: EditorView, url = ""): boolean {
  const { state } = view;
  const selection = state.selection.main;

  if (selection.empty) {
    return false;
  }

  const selectedText = state.doc.sliceString(selection.from, selection.to);

  // Check if already a link [text](url)
  const linkMatch = selectedText.match(/^\[(.*?)\]\((.*?)\)$/);
  if (linkMatch) {
    // Extract just the text part
    const text = linkMatch[1];
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: { anchor: selection.from, head: selection.from + text.length },
    });
  } else {
    // Wrap in link syntax
    const link = `[${selectedText}](${url})`;
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: link },
      // Position cursor at the URL part if empty
      selection: url
        ? { anchor: selection.from, head: selection.from + link.length }
        : {
            anchor: selection.from + selectedText.length + 3,
            head: selection.from + selectedText.length + 3,
          },
    });
  }

  return true;
}

/**
 * Check if the current selection has a specific formatting (markers around it)
 */
function hasFormatting(view: EditorView, marker: string): boolean {
  const { state } = view;
  const selection = state.selection.main;

  if (selection.empty) {
    return false;
  }

  return hasMarkersAround(state, selection.from, selection.to, marker);
}

/**
 * Check if selection is bold
 */
export function isBold(view: EditorView): boolean {
  return hasFormatting(view, "**");
}

/**
 * Check if selection is italic
 */
export function isItalic(view: EditorView): boolean {
  return hasFormatting(view, "*");
}

/**
 * Check if selection has strikethrough
 */
export function isStrikethrough(view: EditorView): boolean {
  return hasFormatting(view, "~~");
}

/**
 * Check if selection is inline code
 */
export function isCode(view: EditorView): boolean {
  return hasFormatting(view, "`");
}

/**
 * Check if selection is highlighted
 */
export function isHighlight(view: EditorView): boolean {
  return hasFormatting(view, "==");
}
