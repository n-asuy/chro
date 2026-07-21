/**
 * Typed cell rendering and inline editors for the cbase table.
 *
 * Display is type-driven (pills for tags, formatted dates, real checkboxes);
 * editors commit through `onCommit` and the table applies the value
 * optimistically while the backend write settles via the watcher-driven
 * re-query.
 */
import { Check } from "lucide-react";
import {
  type FC,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatPropertyValue } from "../runtime";
import { formatDateLabel, toDateInputValue } from "../view-model";
import type { CbasePropertyType } from "../types";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value);

interface CellDisplayProps {
  type: CbasePropertyType;
  value: unknown;
}

/** Read-mode cell body, rendered by property type. */
export const CellDisplay: FC<CellDisplayProps> = ({ type, value }) => {
  if (value === null || value === undefined || value === "") {
    return <span className="text-custom-text-400"> </span>;
  }

  switch (type) {
    case "multi_select": {
      const items = isStringArray(value) ? value : [String(value)];
      return (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {items.map((item) => (
            <span
              key={item}
              className="rounded-full bg-custom-background-80 px-2 py-px text-[11.5px] leading-[18px] text-custom-text-200"
            >
              {item}
            </span>
          ))}
        </span>
      );
    }
    case "select":
      return (
        <span className="inline-flex items-center rounded-full bg-custom-background-80 px-2 py-px text-xs leading-[18px] text-custom-text-200">
          {String(value)}
        </span>
      );
    case "date": {
      const label = formatDateLabel(value);
      return (
        <span className="tabular-nums text-custom-text-200">
          {label ?? formatPropertyValue(value)}
        </span>
      );
    }
    case "number":
      return (
        <span className="w-full text-right tabular-nums text-custom-text-200">
          {formatPropertyValue(value)}
        </span>
      );
    case "url":
      return (
        <span className="truncate text-custom-primary-100">
          {String(value)}
        </span>
      );
    default:
      return <span className="truncate">{formatPropertyValue(value)}</span>;
  }
};

export interface CellEditorProps {
  type: CbasePropertyType;
  value: unknown;
  /** Options for select editors (declared plus in-use values). */
  options: string[];
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}

const editorInputClassName =
  "h-[26px] w-full min-w-0 rounded border border-custom-border-300 bg-custom-background-100 px-1.5 text-[13px] text-custom-text-100 outline-none focus:border-custom-primary-100";

/**
 * Edit-mode cell body. Text-like editors commit on Enter/blur and cancel on
 * Escape; the select editor is a small menu committing on pick.
 */
export const CellEditor: FC<CellEditorProps> = ({
  type,
  value,
  options,
  onCommit,
  onCancel,
}) => {
  switch (type) {
    case "select":
      return (
        <SelectMenu
          current={typeof value === "string" ? value : null}
          options={options}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      );
    case "date":
      return (
        <TextEditor
          initial={toDateInputValue(value)}
          inputType="date"
          onCancel={onCancel}
          onCommit={(text) => onCommit(text === "" ? null : text)}
        />
      );
    case "number":
      return (
        <TextEditor
          initial={
            typeof value === "number" && Number.isFinite(value)
              ? String(value)
              : ""
          }
          inputMode="decimal"
          onCancel={onCancel}
          onCommit={(text) => {
            if (text.trim() === "") return onCommit(null);
            const parsed = Number(text);
            onCommit(Number.isFinite(parsed) ? parsed : null);
          }}
        />
      );
    case "multi_select":
      return (
        <TextEditor
          initial={isStringArray(value) ? value.join(", ") : ""}
          placeholder="tag, another"
          onCancel={onCancel}
          onCommit={(text) => {
            const items = text
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item !== "");
            onCommit(items.length > 0 ? items : null);
          }}
        />
      );
    default:
      return (
        <TextEditor
          initial={typeof value === "string" ? value : formatEmpty(value)}
          onCancel={onCancel}
          onCommit={(text) => onCommit(text === "" ? null : text)}
        />
      );
  }
};

const formatEmpty = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

interface TextEditorProps {
  initial: string;
  inputType?: string;
  inputMode?: "decimal";
  placeholder?: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

const TextEditor: FC<TextEditorProps> = ({
  initial,
  inputType = "text",
  inputMode,
  placeholder,
  onCommit,
  onCancel,
}) => {
  const [text, setText] = useState(initial);
  const committed = useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      committed.current = true;
      onCancel();
    }
  };

  return (
    <input
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      className={editorInputClassName}
      inputMode={inputMode}
      onBlur={commit}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      type={inputType}
      value={text}
    />
  );
};

interface SelectMenuProps {
  current: string | null;
  options: string[];
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}

/** Lightweight option menu anchored under the cell; commits on pick. */
const SelectMenu: FC<SelectMenuProps> = ({
  current,
  options,
  onCommit,
  onCancel,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onCancel();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onCancel]);

  return (
    <div
      className="absolute left-1 top-[calc(100%-4px)] z-30 min-w-[160px] rounded-lg border border-custom-border-300 bg-custom-background-100 p-1 shadow-custom-shadow-sm"
      ref={menuRef}
      role="listbox"
    >
      {options.map((option) => (
        <button
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] text-custom-text-100 hover:bg-custom-background-90"
          key={option}
          onClick={() => onCommit(option)}
          role="option"
          aria-selected={option === current}
          type="button"
        >
          <span className="inline-flex items-center rounded-full bg-custom-background-80 px-2 py-px text-xs leading-[18px] text-custom-text-200">
            {option}
          </span>
          {option === current ? (
            <Check className="ml-auto h-3.5 w-3.5 text-custom-primary-100" />
          ) : null}
        </button>
      ))}
      <form
        className="mt-1 border-t border-custom-border-200 pt-1"
        onSubmit={(event) => {
          event.preventDefault();
          const value = draft.trim();
          if (value !== "") onCommit(value);
        }}
      >
        <input
          className={editorInputClassName}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") onCancel();
          }}
          placeholder={options.length > 0 ? "New option" : "Value"}
          value={draft}
        />
      </form>
      {current !== null ? (
        <button
          className="mt-1 w-full rounded px-2 py-1 text-left text-[12px] text-custom-text-300 hover:bg-custom-background-90 hover:text-custom-text-100"
          onClick={() => onCommit(null)}
          type="button"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
};
