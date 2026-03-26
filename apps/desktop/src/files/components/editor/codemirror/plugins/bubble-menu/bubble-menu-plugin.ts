/**
 * BubbleMenu plugin for CodeMirror 6
 * Tracks selection-driven bubble menu state
 *
 * Shows a floating menu when text is selected.
 * Uses view state to communicate with the React component layer.
 */

import type { EditorView, PluginValue, ViewUpdate } from "@codemirror/view";
import { ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect, type EditorState } from "@codemirror/state";

/**
 * Represents the position and visibility state of the bubble menu
 */
export interface BubbleMenuState {
  /** Whether the menu should be visible */
  visible: boolean;
  /** Selection start position in document */
  from: number;
  /** Selection end position in document */
  to: number;
  /** Bounding rect of the selection in viewport coordinates */
  rect: DOMRect | null;
  /** Selected text content */
  selectedText: string;
}

/**
 * Effect to update the bubble menu state
 */
export const setBubbleMenuState = StateEffect.define<BubbleMenuState>();

/**
 * State field that holds the current bubble menu state
 */
export const bubbleMenuState = StateField.define<BubbleMenuState>({
  create(): BubbleMenuState {
    return {
      visible: false,
      from: 0,
      to: 0,
      rect: null,
      selectedText: "",
    };
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBubbleMenuState)) {
        return effect.value;
      }
    }
    return value;
  },
});

/**
 * Configuration options for the bubble menu plugin
 */
export interface BubbleMenuPluginConfig {
  /**
   * Delay in milliseconds before showing the menu after selection changes.
   * Helps prevent flickering during rapid selection changes.
   * @default 150
   */
  showDelay?: number;

  /**
   * Custom function to determine whether the menu should be shown.
   * Return false to prevent the menu from appearing.
   */
  shouldShow?: (state: EditorState, from: number, to: number) => boolean;
}

/**
 * Get the bounding rect of a text selection
 */
function getSelectionRect(
  view: EditorView,
  from: number,
  to: number,
): DOMRect | null {
  try {
    // Get coordinates for selection range
    const fromCoords = view.coordsAtPos(from);
    const toCoords = view.coordsAtPos(to);

    if (!fromCoords || !toCoords) {
      return null;
    }

    // Handle multi-line selections by getting all line rects
    const fromLine = view.state.doc.lineAt(from);
    const toLine = view.state.doc.lineAt(to);

    if (fromLine.number === toLine.number) {
      // Single line selection
      const left = Math.min(fromCoords.left, toCoords.left);
      const right = Math.max(fromCoords.right, toCoords.right);
      const top = Math.min(fromCoords.top, toCoords.top);
      const bottom = Math.max(fromCoords.bottom, toCoords.bottom);

      return new DOMRect(left, top, right - left, bottom - top);
    }

    // Multi-line selection: get the bounding box of the entire selection
    let minLeft = Infinity;
    let maxRight = -Infinity;
    const minTop = fromCoords.top;
    const maxBottom = toCoords.bottom;

    // Iterate through all lines in selection
    for (let lineNum = fromLine.number; lineNum <= toLine.number; lineNum++) {
      const line = view.state.doc.line(lineNum);
      const lineStart = lineNum === fromLine.number ? from : line.from;
      const lineEnd = lineNum === toLine.number ? to : line.to;

      const startCoords = view.coordsAtPos(lineStart);
      const endCoords = view.coordsAtPos(lineEnd);

      if (startCoords && endCoords) {
        minLeft = Math.min(minLeft, startCoords.left);
        maxRight = Math.max(maxRight, endCoords.right);
      }
    }

    if (minLeft === Infinity || maxRight === -Infinity) {
      return null;
    }

    return new DOMRect(minLeft, minTop, maxRight - minLeft, maxBottom - minTop);
  } catch {
    return null;
  }
}

/**
 * Default shouldShow function - shows menu for non-empty text selections
 */
function defaultShouldShow(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  if (from === to) {
    return false;
  }

  const text = state.doc.sliceString(from, to);
  // Don't show for whitespace-only selections
  if (!text.trim()) {
    return false;
  }

  return true;
}

/**
 * Plugin that manages bubble menu visibility based on selection state
 */
class BubbleMenuPluginValue implements PluginValue {
  private showDelay: number;
  private shouldShow: (state: EditorState, from: number, to: number) => boolean;
  private showTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastFrom = 0;
  private lastTo = 0;

  constructor(
    private view: EditorView,
    config?: BubbleMenuPluginConfig,
  ) {
    this.showDelay = config?.showDelay ?? 150;
    this.shouldShow = config?.shouldShow ?? defaultShouldShow;

    // Initial state check
    this.updateMenuState();
  }

  update(update: ViewUpdate): void {
    // React to selection changes, focus changes, or doc changes
    if (update.selectionSet || update.focusChanged || update.docChanged) {
      this.scheduleUpdate();
    }

    // Also update position on scroll or viewport change
    if (update.geometryChanged) {
      this.updateMenuPosition();
    }
  }

  private scheduleUpdate(): void {
    if (this.showTimeout) {
      clearTimeout(this.showTimeout);
    }

    this.showTimeout = setTimeout(() => {
      this.updateMenuState();
    }, this.showDelay);
  }

  private updateMenuState(): void {
    const { state } = this.view;
    const selection = state.selection.main;
    const from = selection.from;
    const to = selection.to;

    // Check if editor has focus
    const hasFocus = this.view.hasFocus;

    // Determine if we should show the menu
    const shouldShow = hasFocus && this.shouldShow(state, from, to);

    if (!shouldShow) {
      this.hideMenu();
      return;
    }

    // Get selection rect and text
    const rect = getSelectionRect(this.view, from, to);
    const selectedText = state.doc.sliceString(from, to);

    this.lastFrom = from;
    this.lastTo = to;

    this.view.dispatch({
      effects: setBubbleMenuState.of({
        visible: true,
        from,
        to,
        rect,
        selectedText,
      }),
    });
  }

  private updateMenuPosition(): void {
    const currentState = this.view.state.field(bubbleMenuState);
    if (!currentState.visible) {
      return;
    }

    // Update rect position
    const rect = getSelectionRect(this.view, this.lastFrom, this.lastTo);
    if (rect) {
      this.view.dispatch({
        effects: setBubbleMenuState.of({
          ...currentState,
          rect,
        }),
      });
    }
  }

  private hideMenu(): void {
    const currentState = this.view.state.field(bubbleMenuState);
    if (currentState.visible) {
      this.view.dispatch({
        effects: setBubbleMenuState.of({
          visible: false,
          from: 0,
          to: 0,
          rect: null,
          selectedText: "",
        }),
      });
    }
  }

  destroy(): void {
    if (this.showTimeout) {
      clearTimeout(this.showTimeout);
    }
  }
}

/**
 * Create the bubble menu plugin with optional configuration
 */
export function createBubbleMenuPlugin(config?: BubbleMenuPluginConfig) {
  return ViewPlugin.fromClass(
    class extends BubbleMenuPluginValue {
      constructor(view: EditorView) {
        super(view, config);
      }
    },
  );
}

/**
 * Get all extensions needed for bubble menu functionality
 */
export function bubbleMenuExtension(config?: BubbleMenuPluginConfig) {
  return [bubbleMenuState, createBubbleMenuPlugin(config)];
}
