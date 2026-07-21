import { AgentLogo, hasAgentLogo } from "@/components/agent-logo";
import { desktopFetch } from "@/lib/backend-client";
import { slugOrId } from "@/lib/slug";
import type { StoredTask } from "@/session/types";
import { Button } from "@chro/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@chro/ui/popover";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ExternalLink,
  FileText,
  Folder,
  Link2,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

type TaskContextRef = {
  id: string;
  task_id: string;
  task_session_id?: string | null;
  task_run_id?: string | null;
  kind: string;
  target_task_id?: string | null;
  target_session_id?: string | null;
  path?: string | null;
  branch?: string | null;
  mode: string;
  label?: string | null;
  metadata_json?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

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

type ReferenceDirection = "outgoing" | "incoming";

const shortId = (id?: string | null, length = 8): string => {
  if (!id) return "";
  const compact = id.replace(/-/g, "");
  return (compact || id).slice(0, length).toLowerCase();
};

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

const taskTitle = (task: StoredTask | undefined, id?: string | null): string =>
  task?.title?.trim() || (id ? shortId(id) : "Unknown task");

const pathBasename = (path: string): string =>
  path.split("/").filter(Boolean).pop() || path;

const labelForKind = (kind: string): string => {
  switch (kind) {
    case "session":
      return "session";
    case "directory":
      return "dir";
    case "file":
      return "file";
    case "task":
      return "task";
    default:
      return kind;
  }
};

const iconForRef = (ref: TaskContextRef) => {
  if (ref.kind === "file") return FileText;
  if (ref.kind === "directory") return Folder;
  return MessageSquare;
};

export function SessionReferencesPopover({
  taskId,
  tasksById,
  onOpenTask,
  onOpenFile,
  side = "bottom",
  align = "end",
}: SessionReferencesPopoverProps) {
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
  const totalCount =
    (refs?.outgoing.length ?? 0) + (refs?.incoming.length ?? 0);
  const isLoading = refsQuery.isLoading || refsQuery.isFetching;
  const openTask = onOpenTask
    ? (taskIdOrSlug: string) => {
        setOpen(false);
        onOpenTask(taskIdOrSlug);
      }
    : undefined;
  const openFile = onOpenFile
    ? (path: string) => {
        setOpen(false);
        onOpenFile(path);
      }
    : undefined;

  if (!taskId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Open task references"
          className="inline-flex h-9 items-center gap-1.5 rounded-[4px] px-2 text-xs font-medium text-muted-foreground transition hover:!bg-muted/40 hover:!text-primary"
        >
          <Link2 className="h-4 w-4" />
          <span>Refs</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
            {isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              totalCount
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
            <span>References</span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {totalCount} total
          </span>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-2">
          {refsQuery.isError ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">
              Failed to load references.
            </div>
          ) : isLoading && !refs ? (
            <div className="flex items-center justify-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Loading references</span>
            </div>
          ) : totalCount === 0 ? (
            <div className="px-2 py-2 text-center text-[12px] text-muted-foreground">
              No saved references yet.
            </div>
          ) : (
            <>
              {refs && refs.outgoing.length > 0 ? (
                <ReferenceSection
                  direction="outgoing"
                  refs={refs.outgoing}
                  tasksById={tasksById}
                  onOpenTask={openTask}
                  onOpenFile={openFile}
                />
              ) : null}
              {refs && refs.incoming.length > 0 ? (
                <ReferenceSection
                  direction="incoming"
                  refs={refs.incoming}
                  tasksById={tasksById}
                  onOpenTask={openTask}
                  onOpenFile={openFile}
                />
              ) : null}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ReferenceSection({
  direction,
  refs,
  tasksById,
  onOpenTask,
  onOpenFile,
}: {
  direction: ReferenceDirection;
  refs: TaskContextRef[];
  tasksById: Record<string, StoredTask>;
  onOpenTask?: (taskIdOrSlug: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const title = direction === "outgoing" ? "Uses" : "Referenced by";
  const Icon = direction === "outgoing" ? ArrowUpRight : ArrowDownLeft;

  return (
    <section className="mb-2 last:mb-0">
      <div className="mb-1 flex items-center gap-1.5 px-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <Icon className="h-3 w-3" />
        <span>{title}</span>
      </div>
      <div className="space-y-1">
        {refs.map((ref) => (
          <ReferenceRow
            key={ref.id}
            direction={direction}
            refItem={ref}
            tasksById={tasksById}
            onOpenTask={onOpenTask}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </section>
  );
}

function ReferenceRow({
  direction,
  refItem,
  tasksById,
  onOpenTask,
  onOpenFile,
}: {
  direction: ReferenceDirection;
  refItem: TaskContextRef;
  tasksById: Record<string, StoredTask>;
  onOpenTask?: (taskIdOrSlug: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const Icon = iconForRef(refItem);
  const taskId =
    direction === "incoming" ? refItem.task_id : refItem.target_task_id;
  const fallbackId = taskId ?? refItem.target_session_id;
  const task = taskId ? tasksById[taskId] : undefined;
  const path = refItem.path?.trim() || null;
  const isPathRef = refItem.kind === "file" || refItem.kind === "directory";
  // Session/task rows show the logo of the agent that actually ran the
  // referenced session, so the reference is identifiable by executor rather
  // than a generic chat glyph. Falls back to the chat bubble when the
  // referenced session has not run (no recognized executor) yet.
  const executor = !isPathRef ? task?.last_executor : null;
  const showAgentLogo = hasAgentLogo(executor);

  const title = useMemo(() => {
    if (refItem.label?.trim()) return refItem.label.trim();
    if (isPathRef && path) return pathBasename(path);
    return taskTitle(task, fallbackId);
  }, [fallbackId, isPathRef, path, refItem.label, task]);

  const detail = useMemo(() => {
    if (isPathRef && path) return path;
    const id = fallbackId ? shortId(fallbackId) : "missing";
    if (refItem.branch) return `${id} · ${refItem.branch}`;
    return id;
  }, [fallbackId, isPathRef, path, refItem.branch]);

  const openTarget = () => {
    if (isPathRef && path && onOpenFile) {
      onOpenFile(path);
      return;
    }
    if (taskId && onOpenTask) {
      onOpenTask(task ? slugOrId(task) : taskId);
    }
  };

  const canOpen = Boolean(
    (isPathRef && path && onOpenFile) || (taskId && onOpenTask),
  );

  const rowClassName = cn(
    "group/ref flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
    canOpen ? "cursor-pointer hover:bg-muted" : "cursor-default opacity-80",
  );
  const content = (
    <>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground">
        {showAgentLogo ? (
          <AgentLogo agent={executor} className="h-4 w-4" />
        ) : (
          <Icon className="h-4 w-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-foreground">
            {title}
          </span>
          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] leading-none text-muted-foreground">
            {labelForKind(refItem.kind)}
          </span>
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {detail}
        </span>
      </span>
      {canOpen ? (
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover/ref:opacity-100" />
      ) : null}
    </>
  );

  if (canOpen) {
    return (
      <button type="button" onClick={openTarget} className={rowClassName}>
        {content}
      </button>
    );
  }

  return <div className={rowClassName}>{content}</div>;
}
