/**
 * Task list plugin
 * Renders interactive checkboxes for task list items
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { isCursorInRange } from "../../utility/tools";
import type { TreeCursor } from "@lezer/common";

/**
 * Field to track live preview mode
 */
export const editorLivePreviewField = StateField.define<boolean>({
  create: () => true,
  update: (value) => value,
});

// Store the current EditorView for click handling
let taskListCurrentView: EditorView | null = null;

/**
 * Widget for rendering interactive checkboxes
 */
class CheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: string | undefined,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  public override eq(other: CheckboxWidget): boolean {
    return (
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  public override toDOM(): HTMLElement {
    const checkbox = document.createElement("div");
    checkbox.classList.add("cm-task-checkbox-wrapper");
    checkbox.style.cursor = "pointer";

    const isChecked = this.checked && this.checked.toLowerCase() === "x";

    if (isChecked) {
      checkbox.dataset.checked = "true";
    } else if (this.checked && this.checked !== " ") {
      checkbox.dataset.special = this.checked;
      checkbox.innerText = this.checked;
    } else {
      checkbox.dataset.checked = "false";
    }

    // Capture values for closure
    const from = this.from;
    const to = this.to;
    const special =
      this.checked &&
      this.checked !== " " &&
      this.checked.toLowerCase() !== "x";
    const currentChecked = isChecked;

    // Use addEventListener with stopPropagation for reliable click handling
    checkbox.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    checkbox.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (!taskListCurrentView) return;

      const view = taskListCurrentView;
      const char = special ? " " : !currentChecked ? "x" : " ";

      view.dispatch({
        changes: {
          from: from + 1,
          to: to - 1,
          insert: char,
        },
      });
    });

    return checkbox;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * ViewPlugin to track the current EditorView for checkbox click handling
 */
const taskListViewPlugin = ViewPlugin.fromClass(
  class {
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      taskListCurrentView = view;
    }

    update(_update: ViewUpdate) {
      taskListCurrentView = this.view;
    }

    destroy() {
      if (taskListCurrentView === this.view) {
        taskListCurrentView = null;
      }
    }
  },
);

/**
 * Plugin for rendering task list checkboxes
 */
const taskListDecorationPlugin = ViewPlugin.fromClass(
  class {
    public decorations = Decoration.none;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    public update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decorations = new Set<any>();
      const { state } = view;
      const isLivePreview = state.field(editorLivePreviewField);

      for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
          from,
          to,
          enter: (node: TreeCursor) => {
            if (node.type.name !== "Task") return;

            const listItem = node.node.parent;
            if (!listItem || listItem.type.name !== "ListItem") return;

            const listMark = listItem.getChild("ListMark");
            if (!listMark) return;

            const taskMarker = node.node.getChild("TaskMarker");
            if (!taskMarker) return;

            const checkedChar = state.doc.sliceString(
              taskMarker.from + 1,
              taskMarker.to - 1,
            );
            const isChecked = checkedChar && checkedChar.toLowerCase() === "x";

            if (isChecked) {
              const line = state.doc.lineAt(listItem.from);
              decorations.add(
                Decoration.line({
                  attributes: { class: "cm-task-checked" },
                }).range(line.from),
              );
            }

            if (
              isLivePreview &&
              (isCursorInRange(state, [listMark.from, listMark.to]) ||
                isCursorInRange(state, [taskMarker.from, taskMarker.to]))
            ) {
              return;
            }

            decorations.add(
              Decoration.replace({
                widget: new CheckboxWidget(
                  state.doc.sliceString(taskMarker.from + 1, taskMarker.to - 1),
                  taskMarker.from,
                  taskMarker.to,
                ),
              }).range(listMark.from, taskMarker.to),
            );
          },
        });
      }

      return Decoration.set(
        [...decorations].sort((a, b) => a.from - b.from),
        true,
      );
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

/**
 * Combined task list plugin with view tracking and decorations
 */
export const taskListPlugin = [taskListViewPlugin, taskListDecorationPlugin];
