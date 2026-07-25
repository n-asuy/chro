import { useProjectContext } from "@/files/context/project-context";
import {
  clearSearchHistory,
  loadSearchHistory,
  pushSearchHistory,
} from "@/files/lib/search-history";
import { useFilesStore } from "@/files/state/files-store";
import { cn } from "@/lib/cn";
import {
  type ContentSortOrder,
  type ProjectSearchResult,
  type SearchCase,
  type SearchLineMatch,
  searchProjectContent,
  searchProjectFiles,
} from "@/lib/project-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import {
  ArrowDownUp,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  Fragment,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLayoutStore } from "../../state/layout-store";
import { useDockSearchFocusToken } from "../dock-store-context";

const SEARCH_DEBOUNCE_MS = 200;
const MAX_RESULTS = 50;

const SUGGESTION_LISTBOX_ID = "search-suggestion-listbox";
const suggestionOptionId = (index: number) =>
  `${SUGGESTION_LISTBOX_ID}-option-${index}`;

const SORT_LABELS: Record<ContentSortOrder, string> = {
  relevance: "Relevance",
  "modified-desc": "Modified (new to old)",
  "modified-asc": "Modified (old to new)",
  "name-asc": "File name (A to Z)",
  "name-desc": "File name (Z to A)",
  "path-asc": "Path (A to Z)",
  "path-desc": "Path (Z to A)",
};

/** `insert` is the literal text inserted when the row is clicked (if any). */
const OPERATOR_HELP: { token: string; desc: string; insert?: string }[] = [
  { token: "path:", desc: "match file path", insert: "path:" },
  { token: "file:", desc: "match file name", insert: "file:" },
  { token: "content:", desc: "match file content", insert: "content:" },
  { token: "tag:", desc: "match #tag", insert: "tag:" },
  { token: "line:(…)", desc: "keywords on the same line" },
  { token: "match-case:", desc: "case-sensitive", insert: "match-case:" },
  { token: '"…"', desc: "exact phrase" },
  { token: "/…/", desc: "regular expression" },
  { token: "a OR b   -c", desc: "logic: OR, exclude" },
];

/** Fields that offer path/name autocomplete when trailing the query. */
type AutocompleteField = "path" | "file";
type ActiveOperator = {
  field: AutocompleteField;
  partial: string;
  start: number;
};

/**
 * Ring navigation over suggestion indices where `-1` is the "no selection"
 * (free input) slot. Down cycles `-1 → 0 → … → last → -1`; Up reverses it, so
 * the keyboard can always return to free input. Empty lists stay at `-1`.
 */
export function stepSuggestionIndex(
  current: number,
  length: number,
  delta: 1 | -1,
): number {
  if (length === 0) return -1;
  const next = current + delta;
  if (next > length - 1) return -1;
  if (next < -1) return length - 1;
  return next;
}

/** Detect an incomplete `path:`/`file:` operator at the end of the query. */
export function parseTrailingOperator(query: string): ActiveOperator | null {
  const match = /(^|[\s(])(path|file):([^\s"()]*)$/.exec(query);
  if (!match) return null;
  const field = match[2] as AutocompleteField;
  const partial = match[3];
  const start = match.index + match[1].length;
  return { field, partial, start };
}

/**
 * Right-dock full-text search pane, modeled on Obsidian's search pane.
 *
 * Every query runs through the boolean content-search grammar (`AND`/`OR`/`-`,
 * `()`, `"phrases"`, `/regex/`, and the `file:`/`path:`/`content:`/`tag:`/
 * `line:`/`match-case:` operators). Files matched by content show collapsible,
 * highlighted line matches; files matched only by name show as a single row.
 * Focusing the empty box reveals the operator list and recent-search history.
 */
export function SearchDockPanel() {
  const { projectId } = useProjectContext();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectSearchResult[]>([]);
  const [needles, setNeedles] = useState<string[]>([]);
  const [matchCase, setMatchCase] = useState(false);
  const [sort, setSort] = useState<ContentSortOrder>("relevance");
  const [totalFiles, setTotalFiles] = useState(0);
  const [totalLineMatches, setTotalLineMatches] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // Highlighted suggestion for keyboard navigation. -1 means "no selection":
  // the query stays free input and Enter runs the search instead of completing.
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const suggestRequestIdRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);
  const openTab = useLayoutStore((s) => s.openTab);
  const requestEditorReveal = useFilesStore((s) => s.requestEditorReveal);
  const fileTree = useFilesStore((s) => s.fileTree);
  const searchFocusToken = useDockSearchFocusToken();

  const activeOperator = useMemo(
    () => (focused ? parseTrailingOperator(query) : null),
    [focused, query],
  );

  useEffect(() => {
    setHistory(loadSearchHistory());
  }, []);

  // Fetch path/name autocomplete suggestions for a trailing `path:`/`file:`.
  useEffect(() => {
    suggestAbortRef.current?.abort();
    suggestAbortRef.current = null;
    if (!activeOperator || !projectId) {
      setSuggestions([]);
      return;
    }
    const { field, partial } = activeOperator;
    const reqId = ++suggestRequestIdRef.current;
    // Empty partial: offer top-level entries from the loaded tree (instant).
    if (partial === "") {
      setSuggestions(topLevelSuggestions(fileTree, field));
      return;
    }
    const handle = setTimeout(() => {
      const controller = new AbortController();
      suggestAbortRef.current = controller;
      searchProjectFiles(projectId, partial, {
        kind: "name",
        limit: 60,
        signal: controller.signal,
      })
        .then((res) => {
          if (reqId !== suggestRequestIdRef.current) return;
          setSuggestions(buildSuggestions(field, partial, res));
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") return;
          if (reqId === suggestRequestIdRef.current) setSuggestions([]);
        });
    }, 120);
    return () => {
      clearTimeout(handle);
      suggestAbortRef.current?.abort();
    };
  }, [activeOperator, projectId, fileTree]);

  // A fresh suggestion list (new partial, or the popup closing) clears the
  // highlight, so typing always returns to free input.
  useEffect(() => {
    setActiveIndex(-1);
  }, [suggestions]);

  const openResult = useCallback(
    (path: string, line?: number) => {
      openTab(
        { type: "file", path },
        { activate: true, returnFocusOnClose: true },
      );
      if (line !== undefined) {
        requestEditorReveal(path, line);
      }
    },
    [openTab, requestEditorReveal],
  );

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [searchFocusToken]);

  const runSearch = useCallback(
    async (raw: string) => {
      if (!projectId) return;
      const reqId = ++requestIdRef.current;
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const term = raw.trim();
      if (!term) {
        setResults([]);
        setNeedles([]);
        setTotalFiles(0);
        setTotalLineMatches(0);
        setTruncated(false);
        setIsLoading(false);
        setError(null);
        return;
      }
      const caseOption: SearchCase | undefined = matchCase
        ? "sensitive"
        : undefined;
      setIsLoading(true);
      setError(null);
      try {
        const outcome = await searchProjectContent(projectId, term, {
          limit: MAX_RESULTS,
          case: caseOption,
          sort,
          signal: controller.signal,
        });
        if (reqId !== requestIdRef.current) return;
        setResults(outcome.results);
        setTotalFiles(outcome.totalFiles);
        setTotalLineMatches(outcome.totalLineMatches);
        setTruncated(outcome.truncated);
        setNeedles(plainNeedles(term));
        setCollapsed(new Set());
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        if (reqId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
        setTotalFiles(0);
        setTotalLineMatches(0);
        setTruncated(false);
      } finally {
        if (reqId === requestIdRef.current) setIsLoading(false);
      }
    },
    [projectId, matchCase, sort],
  );

  useEffect(() => {
    const handle = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, runSearch]);

  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      suggestAbortRef.current?.abort();
    },
    [],
  );

  const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  }, []);

  const commitToHistory = useCallback(() => {
    if (query.trim()) setHistory(pushSearchHistory(query));
  }, [query]);

  const completeOperator = useCallback(
    (value: string) => {
      if (!activeOperator) return;
      const next = `${query.slice(0, activeOperator.start)}${activeOperator.field}:${value}`;
      setQuery(next);
      inputRef.current?.focus();
    },
    [activeOperator, query],
  );

  const insertOperator = useCallback((token: string) => {
    setQuery((q) => (q && !q.endsWith(" ") ? `${q} ${token}` : `${q}${token}`));
    inputRef.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      const hasSuggestions = activeOperator !== null && suggestions.length > 0;

      switch (e.key) {
        // Cycle the highlight through [-1, 0, …, last] as a ring so there is
        // always a way back to free input (index -1) via the keyboard.
        case "ArrowDown": {
          if (!hasSuggestions) return;
          e.preventDefault();
          setActiveIndex((i) => stepSuggestionIndex(i, suggestions.length, 1));
          break;
        }
        case "ArrowUp": {
          if (!hasSuggestions) return;
          e.preventDefault();
          setActiveIndex((i) => stepSuggestionIndex(i, suggestions.length, -1));
          break;
        }
        // Tab always completes: the highlighted item, or the first as a quick
        // accept when nothing is highlighted.
        case "Tab": {
          if (!hasSuggestions) return;
          e.preventDefault();
          completeOperator(suggestions[activeIndex >= 0 ? activeIndex : 0]);
          break;
        }
        // Enter completes only an explicitly highlighted item; otherwise it
        // leaves the query untouched and records the (already-live) search.
        case "Enter": {
          if (hasSuggestions && activeIndex >= 0) {
            e.preventDefault();
            completeOperator(suggestions[activeIndex]);
          } else {
            commitToHistory();
          }
          break;
        }
        // Dismiss the popup without touching the query; it reopens on the next
        // keystroke that changes the trailing operator.
        case "Escape": {
          if (!hasSuggestions) return;
          e.preventDefault();
          setSuggestions([]);
          break;
        }
      }
    },
    [
      activeOperator,
      suggestions,
      activeIndex,
      completeOperator,
      commitToHistory,
    ],
  );

  const applyHistory = useCallback((entry: string) => {
    setQuery(entry);
    inputRef.current?.focus();
  }, []);

  const clearHistory = useCallback(() => {
    clearSearchHistory();
    setHistory([]);
  }, []);

  // Results arrive already ordered by the server per `sort`; render as-is.
  const hasGroups = useMemo(
    () => results.some((r) => r.line_matches.length > 0),
    [results],
  );

  const toggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleCollapseAll = useCallback(() => {
    setCollapsed((prev) => {
      if (prev.size > 0) return new Set();
      return new Set(
        results.filter((r) => r.line_matches.length > 0).map((r) => r.path),
      );
    });
  }, [results]);

  const showSuggestions = activeOperator !== null && suggestions.length > 0;
  const showFocusPanel = focused && query.trim() === "" && !showSuggestions;
  const empty =
    !isLoading && !error && query.trim() !== "" && results.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative px-2 pt-2">
        <div className="flex items-center gap-1 rounded border border-border bg-background pl-2 pr-1 focus-within:ring-1 focus-within:ring-primary/40">
          <Search className="pointer-events-none h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search…"
            className="h-8 min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground focus:outline-none"
            role="combobox"
            aria-expanded={showSuggestions}
            aria-controls={SUGGESTION_LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              showSuggestions && activeIndex >= 0
                ? suggestionOptionId(activeIndex)
                : undefined
            }
          />
          <IconToggle
            active={matchCase}
            title="Match case"
            onClick={() => setMatchCase((v) => !v)}
          >
            <CaseSensitive className="h-3.5 w-3.5" />
          </IconToggle>
        </div>

        {showSuggestions && activeOperator && (
          <SuggestionPanel
            field={activeOperator.field}
            suggestions={suggestions}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onPick={completeOperator}
          />
        )}

        {showFocusPanel && (
          <FocusPanel
            history={history}
            onInsertOperator={insertOperator}
            onPickHistory={applyHistory}
            onClearHistory={clearHistory}
          />
        )}
      </div>

      {results.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-3 pt-2 text-[11px] text-muted-foreground">
          <span title={truncated ? `Showing top ${results.length}` : undefined}>
            {truncated ? `${totalFiles}+` : totalFiles}{" "}
            {totalFiles === 1 ? "file" : "files"} · {totalLineMatches}{" "}
            {totalLineMatches === 1 ? "match" : "matches"}
            {truncated ? ` · top ${results.length}` : ""}
          </span>
          <div className="flex items-center gap-0.5">
            {hasGroups && (
              <button
                type="button"
                onClick={toggleCollapseAll}
                className="rounded px-1.5 py-0.5 hover:bg-foreground/5 hover:text-foreground"
              >
                {collapsed.size > 0 ? "Expand all" : "Collapse all"}
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-foreground/5 hover:text-foreground"
                  title="Sort order"
                >
                  <ArrowDownUp className="h-3 w-3" />
                  <span className="max-w-[7rem] truncate">
                    {SORT_LABELS[sort]}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[10rem] p-1 text-[11px]"
              >
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(v) => setSort(v as ContentSortOrder)}
                >
                  {(Object.keys(SORT_LABELS) as ContentSortOrder[]).map(
                    (key) => (
                      <DropdownMenuRadioItem
                        key={key}
                        value={key}
                        className="py-1 text-[11px]"
                      >
                        {SORT_LABELS[key]}
                      </DropdownMenuRadioItem>
                    ),
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <DockHint>
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Searching…</span>
          </DockHint>
        ) : error ? (
          <DockHint className="text-red-500">{error}</DockHint>
        ) : empty ? (
          <DockHint>No matches found.</DockHint>
        ) : results.length === 0 ? (
          <DockHint>Type to search.</DockHint>
        ) : (
          <ul className="py-1">
            {results.map((r) =>
              r.line_matches.length > 0 ? (
                <ContentFileGroup
                  key={r.path}
                  path={r.path}
                  matches={r.line_matches}
                  collapsed={collapsed.has(r.path)}
                  onToggle={toggleCollapse}
                  onPickLine={openResult}
                />
              ) : (
                <NameResultRow
                  key={r.path}
                  path={r.path}
                  needles={needles}
                  onOpen={openResult}
                />
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function FocusPanel({
  history,
  onInsertOperator,
  onPickHistory,
  onClearHistory,
}: {
  history: string[];
  onInsertOperator: (token: string) => void;
  onPickHistory: (entry: string) => void;
  onClearHistory: () => void;
}) {
  // Keep focus on the input when interacting with the panel so it stays open.
  const keepFocus = (e: ReactMouseEvent) => e.preventDefault();
  return (
    <div
      onMouseDown={keepFocus}
      className="absolute left-2 right-2 top-[calc(100%-2px)] z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      <div className="px-3 py-2">
        <p className="mb-1.5 text-[11px] font-medium text-foreground">
          Search options
        </p>
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {OPERATOR_HELP.map((op) =>
            op.insert ? (
              <li key={op.token}>
                <button
                  type="button"
                  onClick={() => onInsertOperator(op.insert as string)}
                  className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-foreground/5 hover:text-foreground"
                >
                  <code className="shrink-0 rounded bg-foreground/10 px-1 font-mono text-[10px] text-foreground">
                    {op.token}
                  </code>
                  <span className="truncate">{op.desc}</span>
                </button>
              </li>
            ) : (
              <li
                key={op.token}
                className="flex items-baseline gap-2 px-1 py-0.5"
              >
                <code className="shrink-0 rounded bg-foreground/10 px-1 font-mono text-[10px] text-foreground">
                  {op.token}
                </code>
                <span className="truncate">{op.desc}</span>
              </li>
            ),
          )}
        </ul>
      </div>
      {history.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-medium text-foreground">
              History
            </span>
            <button
              type="button"
              onClick={onClearHistory}
              title="Clear history"
              className="rounded p-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <ul className="space-y-0.5">
            {history.map((entry) => (
              <li key={entry}>
                <button
                  type="button"
                  onClick={() => onPickHistory(entry)}
                  className="block w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                >
                  {entry}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SuggestionPanel({
  field,
  suggestions,
  activeIndex,
  onHover,
  onPick,
}: {
  field: AutocompleteField;
  suggestions: string[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (value: string) => void;
}) {
  const keepFocus = (e: ReactMouseEvent) => e.preventDefault();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Keep the highlighted option in view as the keyboard walks past the fold.
  useEffect(() => {
    if (activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      onMouseDown={keepFocus}
      className="absolute left-2 right-2 top-[calc(100%-2px)] z-50 mt-1 rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      <div
        id={SUGGESTION_LISTBOX_ID}
        role="listbox"
        className="max-h-72 overflow-y-auto py-1"
      >
        {suggestions.map((value, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={value}
              ref={(el) => {
                optionRefs.current[index] = el;
              }}
              id={suggestionOptionId(index)}
              role="option"
              aria-selected={active}
              type="button"
              onClick={() => onPick(value)}
              onMouseMove={() => onHover(index)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1 text-left text-xs",
                active
                  ? "bg-primary/15 text-foreground"
                  : "hover:bg-foreground/5",
              )}
              title={value}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 opacity-50" />
              <span className="truncate">{value}</span>
            </button>
          );
        })}
      </div>
      <p className="border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
        {field === "path" ? "path suggestions" : "file suggestions"} · ↑↓ to
        navigate · Tab to complete
      </p>
    </div>
  );
}

function NameResultRow({
  path,
  needles,
  onOpen,
}: {
  path: string;
  needles: string[];
  onOpen: (path: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(path)}
        className="flex w-full items-start gap-2 px-3 py-1 text-left text-xs hover:bg-foreground/5"
        title={path}
      >
        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-foreground">
            <HighlightedText
              text={basename(path)}
              ranges={computeNeedleRanges(basename(path), needles)}
            />
          </span>
          <span className="truncate text-[10px] text-muted-foreground">
            <HighlightedText
              text={path}
              ranges={computeNeedleRanges(path, needles)}
            />
          </span>
        </div>
      </button>
    </li>
  );
}

function ContentFileGroup({
  path,
  matches,
  collapsed,
  onToggle,
  onPickLine,
}: {
  path: string;
  matches: SearchLineMatch[];
  collapsed: boolean;
  onToggle: (path: string) => void;
  onPickLine: (path: string, line: number) => void;
}) {
  return (
    <li className="mb-1">
      <button
        type="button"
        onClick={() => onToggle(path)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-foreground/5"
        title={path}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        )}
        <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span className="truncate text-xs font-medium text-foreground">
          {basename(path)}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {path}
        </span>
        <span className="ml-auto shrink-0 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums text-muted-foreground">
          {matches.length}
        </span>
      </button>
      {!collapsed && (
        <ul>
          {matches.map((m) => (
            <li key={m.line_number}>
              <button
                type="button"
                onClick={() => onPickLine(path, m.line_number)}
                className="flex w-full items-baseline gap-2 py-[2px] pl-9 pr-3 text-left hover:bg-foreground/5"
              >
                <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {m.line_number}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  <HighlightedText text={m.line_content} ranges={m.ranges} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Render `text` with `ranges` highlighted. Ranges are `[start, end)` offsets;
 * content matches supply UTF-16 offsets from the server, name matches supply
 * client-computed ones — both index the JS string directly.
 */
function HighlightedText({
  text,
  ranges,
}: {
  text: string;
  ranges: [number, number][] | undefined;
}) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    const s = Math.max(cursor, Math.min(start, text.length));
    const e = Math.max(s, Math.min(end, text.length));
    if (s > cursor) {
      parts.push(
        <Fragment key={`t${cursor}`}>{text.slice(cursor, s)}</Fragment>,
      );
    }
    if (e > s) {
      parts.push(
        <mark
          key={`m${s}`}
          className="rounded-[2px] bg-primary/25 px-[1px] text-foreground"
        >
          {text.slice(s, e)}
        </mark>,
      );
    }
    cursor = e;
  }
  if (cursor < text.length) {
    parts.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  }
  return <>{parts}</>;
}

/** Extract plain text needles from a query for best-effort name highlighting. */
function plainNeedles(query: string): string[] {
  const needles: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"/g)) needles.push(m[1]);
  const rest = query.replace(/"[^"]*"/g, " ").replace(/\/[^/]*\//g, " ");
  for (const rawToken of rest.split(/\s+/)) {
    let token = rawToken;
    if (!token || token === "OR" || token.startsWith("-")) continue;
    token = token.replace(/^\(+/, "").replace(/\)+$/, "");
    const colon = token.indexOf(":");
    if (colon !== -1) {
      const field = token.slice(0, colon);
      if (KNOWN_FIELDS.has(field)) {
        token = token.slice(colon + 1).replace(/^#/, "");
      }
    }
    if (token) needles.push(token);
  }
  return needles.map((n) => n.toLowerCase()).filter(Boolean);
}

const MAX_SUGGESTIONS = 20;

/** Build path/file autocomplete suggestions from matched entries. */
function buildSuggestions(
  field: AutocompleteField,
  partial: string,
  entries: ProjectSearchResult[],
): string[] {
  const needle = partial.toLowerCase();
  const set = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, "");
    if (field === "file") {
      // `file:` matches file names only (the search walks files, not dirs), so
      // don't offer directory names as completions.
      if (!entry.is_file) continue;
      const base = path.split("/").pop() ?? path;
      if (base.toLowerCase().includes(needle)) set.add(base);
      continue;
    }
    // path: suggest the full path and any ancestor directory matching the term.
    if (path.toLowerCase().includes(needle)) set.add(path);
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      if (dir.toLowerCase().includes(needle)) set.add(dir);
    }
  }
  return [...set]
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, MAX_SUGGESTIONS);
}

/** Top-level entries from the loaded tree, for an empty `path:`/`file:`. */
function topLevelSuggestions(
  fileTree: { path: string; name: string; type: string }[],
  field: AutocompleteField,
): string[] {
  const out: string[] = [];
  for (const node of fileTree) {
    const path = node.path.replace(/^\/+/, "");
    if (field === "file") {
      // Only files have a meaningful bare name to complete against.
      if (node.type !== "directory") out.push(node.name);
    } else {
      if (path) out.push(path);
    }
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

const KNOWN_FIELDS = new Set([
  "file",
  "path",
  "content",
  "tag",
  "line",
  "section",
  "block",
  "task",
  "task-todo",
  "task-done",
  "match-case",
  "ignore-case",
]);

/** Case-insensitive occurrences of any needle in `text`, sorted and merged. */
function computeNeedleRanges(
  text: string,
  needles: string[],
): [number, number][] {
  if (needles.length === 0) return [];
  const hay = text.toLowerCase();
  if (hay.length !== text.length) return [];
  const ranges: [number, number][] = [];
  for (const needle of needles) {
    if (!needle) continue;
    let from = hay.indexOf(needle);
    while (from !== -1) {
      ranges.push([from, from + needle.length]);
      from = hay.indexOf(needle, from + needle.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function IconToggle({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors",
        active
          ? "bg-primary/20 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function DockHint({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-1.5 px-4 py-3 text-center text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
