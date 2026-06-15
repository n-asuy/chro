import { useProjectContext } from "@/files/context/project-context";
import {
  type FileSearchResult,
  enrichProjectResults,
} from "@/files/lib/file-search";
import { searchProjectFiles } from "@/lib/project-client";
import { cn } from "@/lib/cn";
import { FileText, Loader2, Search } from "lucide-react";
import {
  type ChangeEvent,
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

/**
 * LeftDock search panel. Debounced query against the project files API;
 * results clickable to open as file tabs in the focused pane. Phase 1
 * surface only — full-text content search is a follow-up.
 */
export function SearchDockPanel() {
  const { projectId } = useProjectContext();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const openTab = useLayoutStore((s) => s.openTab);
  const searchFocusToken = useDockSearchFocusToken();

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [searchFocusToken]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!projectId) return;
      const reqId = ++requestIdRef.current;
      if (!q.trim()) {
        setResults([]);
        setIsLoading(false);
        setError(null);
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const raw = await searchProjectFiles(projectId, q, {
          limit: MAX_RESULTS,
        });
        if (reqId !== requestIdRef.current) return;
        const enriched = enrichProjectResults(raw);
        setResults(enriched);
      } catch (err) {
        if (reqId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
      } finally {
        if (reqId === requestIdRef.current) setIsLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    const handle = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, runSearch]);

  const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  }, []);

  const onPickResult = useCallback(
    (path: string) => {
      openTab({ type: "file", path }, { activate: true });
    },
    [openTab],
  );

  const empty = useMemo(
    () =>
      !isLoading && !error && query.trim() !== "" && results.length === 0,
    [error, isLoading, query, results.length],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pt-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={onChange}
            placeholder="Search files…"
            className={cn(
              "h-8 w-full rounded border border-border bg-background pl-7 pr-2 text-xs",
              "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40",
            )}
          />
        </div>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <DockHint>
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Searching…</span>
          </DockHint>
        ) : error ? (
          <DockHint className="text-red-500">{error}</DockHint>
        ) : empty ? (
          <DockHint>No matches.</DockHint>
        ) : results.length === 0 ? (
          <DockHint>Type to search files.</DockHint>
        ) : (
          <ul className="py-1">
            {results.map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  onClick={() => onPickResult(r.path)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-1 text-left text-xs",
                    "hover:bg-foreground/5",
                  )}
                  title={r.path}
                >
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-foreground">
                      {r.path.split("/").pop()}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {r.path}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DockHint({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
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
