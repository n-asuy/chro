/**
 * Change markers for a regular editor: a gutter bar on every line that
 * differs from the file's base version (added, modified, or where lines were
 * deleted). Clicking a bar opens the original lines in place, with a button
 * to revert that change.
 */

import { Chunk } from "@codemirror/merge";
import {
  type EditorState,
  type Extension,
  RangeSet,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
} from "@codemirror/view";

export type LineChangeKind = "added" | "modified" | "deleted";

/** Compare against this text (the base version), or stop marking (null). */
export const setChangeBase = StateEffect.define<string | null>();

const setPeek = StateEffect.define<number | null>();

type ChangeState = {
  base: Text | null;
  chunks: readonly Chunk[];
  /** Start (in the document) of the change whose original lines show. */
  peek: number | null;
};

/** Bounds the diff on every keystroke for very different documents. */
const DIFF_CONFIG = { timeout: 200 };

const changeState = StateField.define<ChangeState>({
  create: () => ({ base: null, chunks: [], peek: null }),
  update(value, tr) {
    let { base, chunks, peek } = value;
    for (const effect of tr.effects) {
      if (effect.is(setChangeBase)) {
        base = effect.value === null ? null : Text.of(effect.value.split("\n"));
        chunks = base ? Chunk.build(base, tr.newDoc, DIFF_CONFIG) : [];
        peek = null;
      }
    }
    if (tr.docChanged && base && base === value.base) {
      chunks = Chunk.updateB(chunks, base, tr.newDoc, tr.changes, DIFF_CONFIG);
      peek = peek === null ? null : tr.changes.mapPos(peek);
    }
    for (const effect of tr.effects) {
      if (effect.is(setPeek)) peek = effect.value;
    }
    // A peek closes once its change is gone (reverted or edited away).
    if (peek !== null && !chunks.some((chunk) => chunk.fromB === peek)) {
      peek = null;
    }
    return { base, chunks, peek };
  },
});

const lineRange = (doc: Text, chunk: Chunk): [number, number] => {
  const first = doc.lineAt(Math.min(chunk.fromB, doc.length)).number;
  if (chunk.fromB === chunk.toB) return [first, first];
  return [first, doc.lineAt(Math.min(chunk.endB, doc.length)).number];
};

const chunkKind = (chunk: Chunk): LineChangeKind =>
  chunk.fromB === chunk.toB
    ? "deleted"
    : chunk.fromA === chunk.toA
      ? "added"
      : "modified";

/** Changed lines by line number. */
export const lineChangeKinds = (
  state: EditorState,
): Map<number, LineChangeKind> => {
  const kinds = new Map<number, LineChangeKind>();
  const { doc } = state;
  for (const chunk of state.field(changeState).chunks) {
    const [first, last] = lineRange(doc, chunk);
    for (let line = first; line <= last; line++) {
      kinds.set(line, chunkKind(chunk));
    }
  }
  return kinds;
};

const chunkAtLine = (state: EditorState, pos: number): Chunk | null => {
  const line = state.doc.lineAt(pos).number;
  return (
    state.field(changeState).chunks.find((chunk) => {
      const [first, last] = lineRange(state.doc, chunk);
      return line >= first && line <= last;
    }) ?? null
  );
};

/** Open (or close) the original lines of the change on the line at `pos`. */
export const toggleChangePeek = (view: EditorView, pos: number): boolean => {
  const chunk = chunkAtLine(view.state, pos);
  if (!chunk) return false;
  const open = view.state.field(changeState).peek === chunk.fromB;
  view.dispatch({ effects: setPeek.of(open ? null : chunk.fromB) });
  return true;
};

/** Restore the base text of the change on the line at `pos`. */
export const revertChange = (view: EditorView, pos: number): boolean => {
  const { base } = view.state.field(changeState);
  const chunk = chunkAtLine(view.state, pos);
  if (!base || !chunk) return false;
  const { doc } = view.state;
  view.dispatch({
    changes: {
      from: chunk.fromB,
      to: Math.min(chunk.toB, doc.length),
      insert: base.sliceString(chunk.fromA, Math.min(chunk.toA, base.length)),
    },
    effects: setPeek.of(null),
    userEvent: "revert",
  });
  return true;
};

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: LineChangeKind) {
    super();
  }

  eq(other: ChangeMarker) {
    return other.kind === this.kind;
  }

  toDOM() {
    const marker = document.createElement("div");
    marker.className = `cm-change-marker cm-change-${this.kind}`;
    return marker;
  }
}

const MARKERS: Record<LineChangeKind, ChangeMarker> = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
};

const gutterMarkers = (state: EditorState): RangeSet<GutterMarker> => {
  const ranges = [...lineChangeKinds(state)].map(([line, kind]) =>
    MARKERS[kind].range(state.doc.line(line).from),
  );
  return RangeSet.of(ranges, true);
};

class PeekWidget extends WidgetType {
  constructor(
    readonly original: string,
    readonly at: number,
  ) {
    super();
  }

  eq(other: PeekWidget) {
    return other.original === this.original && other.at === this.at;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-change-peek";
    const lines = document.createElement("div");
    lines.className = "cm-change-peek-original";
    if (this.original === "") {
      lines.classList.add("cm-change-peek-empty");
      lines.textContent = "Added lines";
    } else {
      for (const text of this.original.replace(/\n$/, "").split("\n")) {
        const line = document.createElement("div");
        line.className = "cm-change-peek-line";
        line.textContent = text || "​";
        lines.appendChild(line);
      }
    }
    const actions = document.createElement("div");
    actions.className = "cm-change-peek-actions";
    const button = (action: string, label: string, run: () => void) => {
      const el = document.createElement("button");
      el.type = "button";
      el.dataset.action = action;
      el.textContent = label;
      el.addEventListener("mousedown", (event) => event.preventDefault());
      el.addEventListener("click", run);
      actions.appendChild(el);
    };
    button("revert", "Revert", () => revertChange(view, this.at));
    button("close", "Close", () =>
      view.dispatch({ effects: setPeek.of(null) }),
    );
    box.append(lines, actions);
    return box;
  }
}

const peekDecorations = EditorView.decorations.compute(
  [changeState],
  (state): DecorationSet => {
    const { base, chunks, peek } = state.field(changeState);
    const chunk = chunks.find((c) => c.fromB === peek);
    if (!base || !chunk) return Decoration.none;
    const { doc } = state;
    const original = base.sliceString(
      chunk.fromA,
      Math.min(chunk.toA, base.length),
    );
    const deletion = chunk.fromB === chunk.toB;
    const pos = deletion
      ? doc.lineAt(Math.min(chunk.fromB, doc.length)).from
      : doc.lineAt(Math.min(chunk.endB, doc.length)).to;
    return Decoration.set(
      Decoration.widget({
        widget: new PeekWidget(original, chunk.fromB),
        block: true,
        side: deletion ? -1 : 1,
      }).range(pos),
    );
  },
);

const changeTheme = EditorView.baseTheme({
  ".cm-change-gutter": { width: "8px", paddingLeft: "2px" },
  ".cm-change-gutter .cm-gutterElement": { cursor: "pointer" },
  ".cm-change-marker": { height: "100%", width: "3px", borderRadius: "1px" },
  ".cm-change-added": { backgroundColor: "#2ea04380" },
  ".cm-change-modified": { backgroundColor: "#3b82f680" },
  ".cm-change-deleted": {
    height: "0",
    width: "0",
    marginTop: "-4px",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid #e5534b",
    borderRadius: "0",
  },
  ".cm-change-peek": {
    margin: "4px 0 6px",
    border: "1px solid rgba(127, 127, 127, 0.25)",
    borderRadius: "6px",
    overflow: "hidden",
    fontSize: "0.9em",
  },
  ".cm-change-peek-original": {
    padding: "4px 10px",
    backgroundColor: "#ee443314",
    whiteSpace: "pre-wrap",
  },
  ".cm-change-peek-line": { textDecoration: "line-through", opacity: "0.75" },
  ".cm-change-peek-empty": { fontStyle: "italic", opacity: "0.7" },
  ".cm-change-peek-actions": {
    display: "flex",
    gap: "4px",
    justifyContent: "flex-end",
    padding: "4px 6px",
    borderTop: "1px solid rgba(127, 127, 127, 0.2)",
  },
  ".cm-change-peek-actions button": {
    padding: "1px 8px",
    border: "none",
    borderRadius: "4px",
    background: "transparent",
    color: "inherit",
    fontSize: "12px",
    cursor: "pointer",
  },
  ".cm-change-peek-actions button:hover": {
    background: "rgba(127, 127, 127, 0.15)",
  },
});

export const changeMarkers = (): Extension => [
  changeState,
  gutter({
    class: "cm-change-gutter",
    markers: (view) => gutterMarkers(view.state),
    domEventHandlers: {
      mousedown: (view, line) => toggleChangePeek(view, line.from),
    },
  }),
  peekDecorations,
  changeTheme,
];
