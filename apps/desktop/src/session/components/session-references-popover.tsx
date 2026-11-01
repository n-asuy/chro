import {
  type TranslationFunction,
  type TranslationKey,
  useLanguage,
} from "@/i18n";
import { desktopFetch } from "@/lib/backend-client";
import { slugOrId } from "@/lib/slug";
import { useTaskStatusDot } from "@/session/hooks";
import {
  type SessionRelation,
  type SessionRelationKind,
  type TaskContextRef,
  sessionRelations,
} from "@/session/lib/session-relations";
import type { StoredTask } from "@/session/types";
import { Button } from "@chro/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@chro/ui/popover";
import { useQuery } from "@tanstack/react-query";
import { FileText, Folder, Link2, Loader2, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SessionActivityIndicator } from "./session-activity-indicator";
import { SessionLeadingMarker } from "./session-leading-marker";

type TaskContextRefsResponse = {
  refs: TaskContextRef[];
};

type TaskContextRefsResult = {
  outgoing: TaskContextRef[];
  incoming: TaskContextRef[];
};

type SessionReferencesPopoverProps = {
  taskId?: string | null;
  tasksById: Record<string, StoredTask>;
  onOpenTask?: (taskIdOrSlug: string) => void;
  onOpenFile?: (path: string) => void;
  /** Side the popover opens toward. Use "top" when anchored at the bottom of
   * the viewport, such as the prompt composer toolbar. */
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
};

const RELATION_LABEL: Record<SessionRelationKind, TranslationKey> = {
  delegated_to: "relationDelegatedTo",
  delegated_from: "relationDelegatedFrom",
  continued_from: "relationContinuedFrom",
  continued_in: "relationContinuedIn",
  uses: "relationUses",
  referenced_by: "relationReferencedBy",
};

const shortId = (id: string): string => id.replace(/-/g, "").slice(0, 4);

const fetchTaskContextRefs = async (
  taskId: string,
): Promise<TaskContextRefsResult> => {
  const encoded = encodeURIComponent(taskId);
  const [outgoing, incoming] = await Promise.all([
    desktopFetch<TaskContextRefsResponse>(`/rpc/tasks/${encoded}/context-refs`),
    desktopFetch<TaskContextRefsResponse>(
      `/rpc/tasks/${encoded}/referenced-by`,
    ),
  ]);
  return {
    outgoing: outgoing.refs,
    incoming: incoming.refs,
  };
};

/**
 * Every session and file this session is related to, one row per
 * counterpart: the relation (delegated to / from, continued from / in, uses,
 * referenced by) is written on the row instead of splitting the list into
 * sections, the way issue trackers list linked items.
 */
export function SessionReferencesPopover({
  taskId,
  tasksById,
  onOpenTask,
  onOpenFile,
  side = "bottom",
  align = "end",
}: SessionReferencesPopoverProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const refsQuery = useQuery({
    queryKey: ["task-context-refs", taskId],
    queryFn: () => fetchTaskContextRefs(taskId ?? ""),
    enabled: Boolean(taskId),
    staleTime: 10_000,
  });
  const { refetch } = refsQuery;

  useEffect(() => {
    if (open && taskId) {
      void refetch();
    }
  }, [open, refetch, taskId]);

  const refs = refsQuery.data;
  const relations = useMemo(
    () =>
      refs && taskId
        ? sessionRelations(taskId, refs.outgoing, refs.incoming, tasksById)
        : [],
    [refs, taskId, tasksById],
  );
  const isLoading = refsQuery.isLoading || refsQuery.isFetching;

  const openRelation = (relation: SessionRelation) => {
    if (relation.path && onOpenFile) {
      setOpen(false);
      onOpenFile(relation.path);
      return;
    }
    if (relation.taskId && onOpenTask) {
      setOpen(false);
      const task = tasksById[relation.taskId];
      onOpenTask(task ? slugOrId(task) : relation.taskId);
    }
  };

  if (!taskId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t("referencesOpen")}
          className="inline-flex h-9 items-center gap-1.5 rounded-[4px] px-2 text-xs font-medium text-muted-foreground transition hover:!bg-muted/40 hover:!text-primary"
        >
          <Link2 className="h-4 w-4" />
          <span>Refs</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
            {isLoading && !refs ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              relations.length
            )}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        className="w-[360px] rounded-xl border border-border bg-popover p-0 shadow-sm"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
            <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{t("references")}</span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {relations.length}
          </span>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1.5">
          {refsQuery.isError ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">
              {t("referencesLoadFailed")}
            </div>
          ) : isLoading && !refs ? (
            <div className="flex items-center justify-center px-2 py-3 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </div>
          ) : relations.length === 0 ? (
            <div className="px-2 py-2 text-center text-[12px] text-muted-foreground">
              {t("referencesEmpty")}
            </div>
          ) : (
            relations.map((relation) => (
              <RelationRow
                key={relation.key}
                relation={relation}
                task={relation.taskId ? tasksById[relation.taskId] : undefined}
                canOpen={Boolean(
                  (relation.path && onOpenFile) ||
                    (relation.taskId && onOpenTask),
                )}
                onOpen={() => openRelation(relation)}
                t={t}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RelationRow({
  relation,
  task,
  canOpen,
  onOpen,
  t,
}: {
  relation: SessionRelation;
  task: StoredTask | undefined;
  canOpen: boolean;
  onOpen: () => void;
  t: TranslationFunction;
}) {
  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={onOpen}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left enabled:cursor-pointer enabled:hover:bg-muted disabled:cursor-default"
    >
      <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        {task ? (
          <TaskMarker task={task} t={t} />
        ) : relation.path ? (
          relation.isDirectory ? (
            <Folder className="h-3.5 w-3.5" />
          ) : (
            <FileText className="h-3.5 w-3.5" />
          )
        ) : (
          <MessageSquare className="h-3.5 w-3.5" />
        )}
      </span>
      {relation.taskId ? (
        <span className="w-8 shrink-0 font-mono text-[11px] text-muted-foreground">
          {shortId(relation.taskId)}
        </span>
      ) : null}
      <span
        className="min-w-0 flex-1 truncate text-[13px] text-foreground"
        title={relation.path ?? undefined}
      >
        {relation.title}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <span>{t(RELATION_LABEL[relation.relation])}</span>
        {relation.state === "running" ? (
          <SessionActivityIndicator
            awaitingInput={Boolean(task?.awaiting_input)}
            t={t}
            className="h-3 w-3"
          />
        ) : relation.state ? (
          <span>
            ·{" "}
            {t(
              relation.state === "failed"
                ? "delegationFailed"
                : "delegationDone",
            )}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** The session-list status marker, so a related session reads the same here
 * as in the left panel. A hook, hence its own component. */
function TaskMarker({ task, t }: { task: StoredTask; t: TranslationFunction }) {
  const dotKind = useTaskStatusDot(task);
  return <SessionLeadingMarker kind={dotKind} t={t} />;
}
