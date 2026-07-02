/**
 * CsvEditor - native spreadsheet editor for .csv / .tsv files.
 *
 * Rendered with chro's own table vocabulary (the cbase table look: fixed
 * layout, sticky header, hairline borders) rather than a third-party grid, but
 * with spreadsheet interaction layered on top: an active-cell cursor, arrow /
 * tab navigation, type-to-edit, range selection (drag or shift), clipboard
 * copy / cut / paste, and column resize.
 *
 * The file content is the single source of truth: it is parsed into a `CsvData`
 * grid and re-parsed only when the incoming content differs from what this
 * component last emitted (a file switch or external reload). It never emits on
 * the initial parse, so it cannot trigger a spurious autosave / reload loop.
 */
import { cn } from "@chro/ui/utils";
import { Plus, Trash2 } from "lucide-react";
import {
  type CSSProperties,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CsvData,
  type CsvDelimiter,
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  parseCsv,
  serializeCsv,
  setCell,
  writeBlock,
} from "../../lib/csv";

interface CsvEditorProps {
  content: string;
  delimiter: CsvDelimiter;
  fileName: string;
  pathLabel?: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
}

interface CellRef {
  r: number;
  c: number;
}

const DEFAULT_COLUMN_WIDTH = 168;
const MIN_COLUMN_WIDTH = 64;
const ROW_HEIGHT = 32;
const ACCENT = "#299ad6";

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

/** Split clipboard text into a 2D block (TSV first, falling back to CSV). */
const parseClipboard = (text: string): string[][] => {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  if (trimmed === "") return [[""]];
  const delimiter = trimmed.includes("\t") ? "\t" : ",";
  return trimmed.split("\n").map((line) => line.split(delimiter));
};

export const CsvEditor: FC<CsvEditorProps> = ({
  content,
  delimiter,
  fileName,
  pathLabel,
  onChange,
  readOnly = false,
}) => {
  const [data, setData] = useState<CsvData>(() => parseCsv(content, delimiter));
  const [active, setActive] = useState<CellRef>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<CellRef>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{
    r: number;
    c: number;
    initial: string;
  } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});

  const lastEmitted = useRef(content);
  const gridRef = useRef<HTMLDivElement>(null);
  const activeCellRef = useRef<HTMLTableCellElement>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const draggingRef = useRef(false);
  const resizeRef = useRef<{
    col: number;
    startX: number;
    startW: number;
  } | null>(null);

  const rowCount = data.rows.length;
  const colCount = data.columnCount;

  useEffect(() => {
    if (content !== lastEmitted.current) {
      lastEmitted.current = content;
      setData(parseCsv(content, delimiter));
      setEditing(null);
      setActive({ r: 0, c: 0 });
      setAnchor({ r: 0, c: 0 });
    }
  }, [content, delimiter]);

  const commit = useCallback(
    (next: CsvData) => {
      setData(next);
      const text = serializeCsv(next);
      lastEmitted.current = text;
      onChange(text);
    },
    [onChange],
  );

  const focusGrid = useCallback(() => gridRef.current?.focus(), []);

  const selectCell = useCallback(
    (r: number, c: number, extend: boolean) => {
      const next = { r: clamp(r, rowCount - 1), c: clamp(c, colCount - 1) };
      setActive(next);
      if (!extend) setAnchor(next);
    },
    [rowCount, colCount],
  );

  const startEdit = useCallback(
    (r: number, c: number, initial?: string) => {
      if (readOnly) return;
      setActive({ r, c });
      setAnchor({ r, c });
      setEditing({ r, c, initial: initial ?? data.rows[r]?.[c] ?? "" });
    },
    [readOnly, data],
  );

  const applyEdit = useCallback(
    (r: number, c: number, value: string, move: CellRef | null) => {
      if (data.rows[r]?.[c] !== value) commit(setCell(data, r, c, value));
      setEditing(null);
      if (move) selectCell(r + move.r, c + move.c, false);
      focusGrid();
    },
    [data, commit, selectCell, focusGrid],
  );

  const selection = useMemo(() => {
    return {
      minR: Math.min(active.r, anchor.r),
      maxR: Math.max(active.r, anchor.r),
      minC: Math.min(active.c, anchor.c),
      maxC: Math.max(active.c, anchor.c),
    };
  }, [active, anchor]);

  const clearSelection = useCallback(() => {
    if (readOnly) return;
    const { minR, maxR, minC, maxC } = selection;
    const block = Array.from({ length: maxR - minR + 1 }, () =>
      Array.from({ length: maxC - minC + 1 }, () => ""),
    );
    commit(writeBlock(data, minR, minC, block));
  }, [readOnly, selection, data, commit]);

  const copySelection = useCallback(async () => {
    const { minR, maxR, minC, maxC } = selection;
    const tsv = data.rows
      .slice(minR, maxR + 1)
      .map((row) => row.slice(minC, maxC + 1).join("\t"))
      .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // Clipboard access can be denied; nothing else to do.
    }
  }, [selection, data]);

  const pasteClipboard = useCallback(async () => {
    if (readOnly) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    const block = parseClipboard(text);
    const next = writeBlock(data, active.r, active.c, block);
    commit(next);
    setAnchor({ r: active.r, c: active.c });
    setActive({
      r: active.r + block.length - 1,
      c: active.c + Math.max(0, ...block.map((row) => row.length)) - 1,
    });
  }, [readOnly, data, active, commit]);

  const handleGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editingRef.current) return;
      const mod = event.metaKey || event.ctrlKey;

      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          return selectCell(active.r - 1, active.c, event.shiftKey);
        case "ArrowDown":
          event.preventDefault();
          return selectCell(active.r + 1, active.c, event.shiftKey);
        case "ArrowLeft":
          event.preventDefault();
          return selectCell(active.r, active.c - 1, event.shiftKey);
        case "ArrowRight":
          event.preventDefault();
          return selectCell(active.r, active.c + 1, event.shiftKey);
        case "Tab":
          event.preventDefault();
          return selectCell(
            active.r,
            active.c + (event.shiftKey ? -1 : 1),
            false,
          );
        case "Enter":
        case "F2":
          event.preventDefault();
          return startEdit(active.r, active.c);
        case "Backspace":
        case "Delete":
          event.preventDefault();
          return clearSelection();
        case "Escape":
          event.preventDefault();
          return setAnchor({ r: active.r, c: active.c });
        default:
          break;
      }

      if (mod && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void copySelection();
      } else if (mod && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteClipboard();
      } else if (mod && event.key.toLowerCase() === "x") {
        event.preventDefault();
        void copySelection().then(clearSelection);
      } else if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setAnchor({ r: 0, c: 0 });
        setActive({ r: rowCount - 1, c: colCount - 1 });
      } else if (!mod && event.key.length === 1) {
        event.preventDefault();
        startEdit(active.r, active.c, event.key);
      }
    },
    [
      active,
      rowCount,
      colCount,
      selectCell,
      startEdit,
      clearSelection,
      copySelection,
      pasteClipboard,
    ],
  );

  const handleCellMouseDown = useCallback(
    (event: ReactMouseEvent, r: number, c: number) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (event.shiftKey) {
        setActive({ r, c });
      } else {
        setActive({ r, c });
        setAnchor({ r, c });
        draggingRef.current = true;
      }
      focusGrid();
    },
    [focusGrid],
  );

  const handleCellMouseEnter = useCallback((r: number, c: number) => {
    if (draggingRef.current) setActive({ r, c });
  }, []);

  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // Column resize, mirroring the cbase table interaction.
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const state = resizeRef.current;
      if (!state) return;
      const width = Math.max(
        MIN_COLUMN_WIDTH,
        Math.round(state.startW + event.clientX - state.startX),
      );
      setColumnWidths((prev) => ({ ...prev, [state.col]: width }));
    };
    const up = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  // Keep the active cell in view when navigating by keyboard.
  useLayoutEffect(() => {
    activeCellRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [active]);

  const columnWidth = useCallback(
    (col: number) => columnWidths[col] ?? DEFAULT_COLUMN_WIDTH,
    [columnWidths],
  );

  const tableWidth = useMemo(() => {
    let total = 0;
    for (let c = 0; c < colCount; c++) total += columnWidth(c);
    return total;
  }, [colCount, columnWidth]);

  const isSelected = (r: number, c: number) =>
    r >= selection.minR &&
    r <= selection.maxR &&
    c >= selection.minC &&
    c <= selection.maxC;

  const renderEditor = (r: number, c: number, initial: string) => (
    <input
      // biome-ignore lint/a11y/noAutofocus: focus follows the active editing cell
      autoFocus
      defaultValue={initial}
      onFocus={(event) => {
        const end = event.currentTarget.value.length;
        event.currentTarget.setSelectionRange(end, end);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          applyEdit(r, c, event.currentTarget.value, { r: 1, c: 0 });
        } else if (event.key === "Tab") {
          event.preventDefault();
          applyEdit(r, c, event.currentTarget.value, {
            r: 0,
            c: event.shiftKey ? -1 : 1,
          });
        } else if (event.key === "Escape") {
          event.preventDefault();
          setEditing(null);
          focusGrid();
        }
      }}
      onBlur={(event) => {
        if (editingRef.current?.r === r && editingRef.current?.c === c) {
          applyEdit(r, c, event.currentTarget.value, null);
        }
      }}
      className="block h-full w-full bg-custom-background-100 px-3 text-[13px] text-custom-text-100 outline-none"
    />
  );

  const cellShadow = (r: number, c: number): CSSProperties | undefined =>
    active.r === r && active.c === c
      ? { boxShadow: `inset 0 0 0 2px ${ACCENT}` }
      : undefined;

  const isEditingCell = (r: number, c: number) =>
    editing?.r === r && editing?.c === c;

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-100 font-workspace text-[13px]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-custom-border-300 bg-custom-background-90 px-4 text-[12px] text-custom-text-300">
        <span className="font-medium text-custom-text-100">{fileName}</span>
        {pathLabel ? <span>{pathLabel}</span> : null}
        {readOnly ? (
          <span className="ml-auto italic">read-only</span>
        ) : (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => commit(addRow(data, active.r + 1))}
              className="flex h-7 items-center gap-1 rounded px-2 hover:bg-custom-background-80 hover:text-custom-text-100"
            >
              <Plus className="h-3.5 w-3.5" />
              Row
            </button>
            <button
              type="button"
              onClick={() => commit(addColumn(data, active.c + 1))}
              className="flex h-7 items-center gap-1 rounded px-2 hover:bg-custom-background-80 hover:text-custom-text-100"
            >
              <Plus className="h-3.5 w-3.5" />
              Column
            </button>
            <button
              type="button"
              title="Delete current row"
              onClick={() => {
                commit(deleteRow(data, active.r));
                selectCell(active.r, active.c, false);
              }}
              className="flex h-7 items-center gap-1 rounded px-2 hover:bg-custom-background-80 hover:text-custom-text-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Row
            </button>
            <button
              type="button"
              title="Delete current column"
              onClick={() => {
                commit(deleteColumn(data, active.c));
                selectCell(active.r, active.c, false);
              }}
              className="flex h-7 items-center gap-1 rounded px-2 hover:bg-custom-background-80 hover:text-custom-text-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Column
            </button>
          </div>
        )}
      </header>

      <div
        ref={gridRef}
        role="grid"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-driven grid composite widget
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        className="show-scrollbar min-h-0 flex-1 overflow-auto outline-none"
      >
        <table
          className="table-fixed border-collapse bg-custom-background-100"
          style={{ width: `${tableWidth}px` }}
        >
          <colgroup>
            {Array.from({ length: colCount }, (_, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: column index is the column identity
              <col key={c} style={{ width: `${columnWidth(c)}px` }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-custom-background-90">
            <tr className="h-11 text-[13px] font-medium text-custom-text-300">
              {Array.from({ length: colCount }, (_, c) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: column index is the column identity
                  key={c}
                  ref={
                    active.r === 0 && active.c === c ? activeCellRef : undefined
                  }
                  onMouseDown={(event) => handleCellMouseDown(event, 0, c)}
                  onMouseEnter={() => handleCellMouseEnter(0, c)}
                  onDoubleClick={() => startEdit(0, c)}
                  className={cn(
                    "relative border-r border-b border-custom-border-300 p-0 text-left align-middle",
                    isSelected(0, c) && "bg-[#299ad6]/15",
                  )}
                  style={cellShadow(0, c)}
                >
                  {isEditingCell(0, c) ? (
                    renderEditor(0, c, editing?.initial ?? "")
                  ) : (
                    <div className="truncate px-3">
                      {data.rows[0]?.[c] || " "}
                    </div>
                  )}
                  {!readOnly ? (
                    <button
                      type="button"
                      aria-label="Resize column"
                      onMouseDown={(event) => event.stopPropagation()}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        resizeRef.current = {
                          col: c,
                          startX: event.clientX,
                          startW: columnWidth(c),
                        };
                        document.body.style.cursor = "col-resize";
                      }}
                      className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none select-none border-0 bg-transparent p-0"
                    />
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount - 1 }, (_, bodyIndex) => {
              const r = bodyIndex + 1;
              return (
                <tr
                  key={r}
                  className="border-b border-custom-border-300 text-[13px]"
                  style={{ height: `${ROW_HEIGHT}px` }}
                >
                  {Array.from({ length: colCount }, (_, c) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: column index is the column identity
                      key={c}
                      ref={
                        active.r === r && active.c === c
                          ? activeCellRef
                          : undefined
                      }
                      onMouseDown={(event) => handleCellMouseDown(event, r, c)}
                      onMouseEnter={() => handleCellMouseEnter(r, c)}
                      onDoubleClick={() => startEdit(r, c)}
                      className={cn(
                        "border-r border-custom-border-300 p-0 align-middle text-custom-text-100",
                        isSelected(r, c) && "bg-[#299ad6]/15",
                      )}
                      style={cellShadow(r, c)}
                    >
                      {isEditingCell(r, c) ? (
                        renderEditor(r, c, editing?.initial ?? "")
                      ) : (
                        <div className="truncate px-3">
                          {data.rows[r]?.[c] || " "}
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="flex h-10 shrink-0 items-center gap-4 border-t border-custom-border-300 bg-custom-background-90 px-5 text-[12px] text-custom-text-300">
        <span>
          {rowCount - 1} {rowCount - 1 === 1 ? "row" : "rows"}
        </span>
        <span>
          {colCount} {colCount === 1 ? "column" : "columns"}
        </span>
        <span>
          R{active.r + 1}, C{active.c + 1}
        </span>
      </footer>
    </div>
  );
};
