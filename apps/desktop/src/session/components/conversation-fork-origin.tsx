import type { TranslationFunction } from "@/i18n";
import { desktopFetch } from "@/lib/backend-client";
import { EntryList } from "@/session/conversation-view";
import { loadHistoricTaskRunEntries } from "@/session/hooks/use-conversation-history";
import type { DisplayEntry } from "@/session/types";
import { GitBranch } from "lucide-react";
import type { MutableRefObject } from "react";
import { useEffect, useRef, useState } from "react";

/**
 * How many of the source's runs are inlined above the boundary. Enough to read
 * the recent context in place; anything older is one click away through the
 * boundary link, so an unbounded load would only slow the pane down.
 */
const MAX_INLINED_SOURCE_RUNS = 5;

interface ForkEdge {
  sourceTaskId: string;
  anchorRunId: string | null;
  /** "native" (conversation duplicated) or "digest" (summary only). */
  mode: string;
  /** Source title snapshotted at fork time. */
  label: string | null;
}

interface ContextRefRecord {
  kind: string;
  target_task_id: string | null;
  mode: string;
  label: string | null;
  metadata_json: string | null;
}

interface RunRecord {
  id: string;
  created_at: string;
}

/**
 * Read the fork edge of a task, if any.
 *
 * The edge is provenance written at fork time; its absence simply means this
 * session was not forked and the conversation renders as usual.
 */
export function useForkEdge(taskId: string | null): ForkEdge | null {
  const [edge, setEdge] = useState<ForkEdge | null>(null);

  useEffect(() => {
    setEdge(null);
    if (!taskId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await desktopFetch<{ refs: ContextRefRecord[] }>(
          `/rpc/tasks/${encodeURIComponent(taskId)}/context-refs`,
        );
        if (cancelled) return;
        const fork = response.refs.find(
          (ref) => ref.kind === "fork" && ref.target_task_id,
        );
        if (!fork) return;
        let anchorRunId: string | null = null;
        if (fork.metadata_json) {
          try {
            const meta = JSON.parse(fork.metadata_json) as {
              run_id?: string;
            };
            anchorRunId = meta.run_id ?? null;
          } catch {
            // A malformed anchor only widens the inlined range; the edge and
            // its link stay usable.
          }
        }
        setEdge({
          sourceTaskId: fork.target_task_id as string,
          anchorRunId,
          mode: fork.mode,
          label: fork.label,
        });
      } catch (error) {
        console.warn("[fork-origin] failed to load context refs", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return edge;
}

interface ForkOriginProps {
  edge: ForkEdge;
  onNavigateToSource: (sourceTaskId: string) => void;
  /** Scroll container of the conversation, for prepend compensation. */
  scrollContainerRef?: MutableRefObject<HTMLDivElement | null>;
  t: TranslationFunction;
}

/**
 * The conversation-side rendering of a fork edge: the source's history above a
 * "continued from" boundary, with this session's own turns below.
 *
 * Invariant: what appears above the boundary is what the agent actually
 * inherited. A native fork inlines the source conversation; a digest fork shows
 * only the carried summary, because showing the full history would overstate
 * what the agent knows.
 */
export function ConversationForkOrigin({
  edge,
  onNavigateToSource,
  scrollContainerRef,
  t,
}: ForkOriginProps) {
  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [summary, setSummary] = useState<{
    user: string | null;
    assistant: string | null;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Loading finished content above the viewport shifts everything down. The
  // desktop rule is that the viewport never moves without user intent, so the
  // scroll position is compensated by exactly the height this block gained.
  const lastHeightRef = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    const scroller = scrollContainerRef?.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const next = el.offsetHeight;
      const delta = next - lastHeightRef.current;
      lastHeightRef.current = next;
      if (scroller && delta > 0) {
        scroller.scrollTop += delta;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setSummary(null);

    if (edge.mode !== "native") {
      void (async () => {
        try {
          const exchange = await desktopFetch<{
            user: string | null;
            assistant: string | null;
          }>(`/rpc/tasks/${encodeURIComponent(edge.sourceTaskId)}/last-message`);
          if (!cancelled) setSummary(exchange);
        } catch (error) {
          console.warn("[fork-origin] failed to load source summary", error);
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const response = await desktopFetch<{ runs: RunRecord[] }>(
          `/rpc/tasks/${encodeURIComponent(edge.sourceTaskId)}/runs`,
        );
        if (cancelled) return;
        // Only history up to the anchor belongs above the boundary: the fork
        // never saw anything the source did afterwards.
        const ascending = [...response.runs].sort((a, b) =>
          a.created_at.localeCompare(b.created_at),
        );
        const anchorIndex = edge.anchorRunId
          ? ascending.findIndex((run) => run.id === edge.anchorRunId)
          : -1;
        const upToAnchor =
          anchorIndex >= 0 ? ascending.slice(0, anchorIndex + 1) : ascending;
        const window = upToAnchor.slice(-MAX_INLINED_SOURCE_RUNS);

        const perRun = new Map<string, DisplayEntry[]>();
        await Promise.allSettled(
          window.map((run) =>
            loadHistoricTaskRunEntries(run.id, (runEntries) => {
              perRun.set(run.id, runEntries);
            }),
          ),
        );
        if (cancelled) return;
        setEntries(window.flatMap((run) => perRun.get(run.id) ?? []));
      } catch (error) {
        console.warn("[fork-origin] failed to load source history", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [edge.sourceTaskId, edge.anchorRunId, edge.mode]);

  const isDigest = edge.mode !== "native";

  return (
    <div ref={containerRef}>
      {isDigest ? (
        summary && (summary.user || summary.assistant) ? (
          <div className="mx-auto w-full max-w-2xl pb-2 text-sm leading-relaxed text-muted-foreground">
            {summary.user ? (
              <p className="whitespace-pre-wrap break-words font-medium">
                {summary.user}
              </p>
            ) : null}
            {summary.assistant ? (
              <p className="mt-2 whitespace-pre-wrap break-words">
                {summary.assistant}
              </p>
            ) : null}
          </div>
        ) : null
      ) : entries.length > 0 ? (
        <div className="opacity-80">
          <EntryList entries={entries} />
        </div>
      ) : null}
      <div className="mx-auto flex w-full max-w-2xl items-center gap-3 py-4">
        <div className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => onNavigateToSource(edge.sourceTaskId)}
          className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
          title={edge.label ?? undefined}
        >
          <GitBranch className="h-3.5 w-3.5" />
          {isDigest ? t("continuedFromTaskSummary") : t("continuedFromTask")}
        </button>
        <div className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
