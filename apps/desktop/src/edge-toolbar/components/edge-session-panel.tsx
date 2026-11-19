import { AgentLogo, hasAgentLogo } from "@/components/agent-logo";
import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { AgentUserQuestion } from "@/session/components/agent-user-question";
import { McpToolApproval } from "@/session/components/mcp-tool-approval";
import { TaskConversation } from "@/session/components/task-conversation";
import { useDiffStream } from "@/session/hooks/use-diff-stream";
import { useSessionApprovals } from "@/session/hooks/use-session-approvals";
import { useMarkViewedWhenActive } from "@/session/hooks/use-session-read-state";
import { useSessionRunController } from "@/session/hooks/use-session-run-controller";
import type { StoredTask } from "@/session/types";
import { useAllProjects } from "@/workspace-layout/hooks/use-all-projects";
import { ExternalLink, GitBranch } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { conversationTail } from "../domain/conversation-tail";
import {
  type EdgeSessionState,
  edgeDotStatus,
  panelSessionState,
} from "../domain/edge-sessions";
import { useEdgeConversation } from "../hooks/use-edge-conversation";
import { openSessionInApp } from "../lib/edge-window-client";
import { useEdgeToolbarStore } from "../state/edge-toolbar-store";
import { EdgeComposer } from "./edge-composer";
import { EdgeKeyboardHelp } from "./edge-keyboard-help";
import { type EdgePagerControls, EdgePanelHeader } from "./edge-panel-header";
import { usePanelReady } from "./edge-panel-ready";

/** Turns of the conversation the compact panel shows. */
const TAIL_TURNS = 3;

const noop = () => {};

/** The panel's height: tall enough for a question card and a reply. */
export function edgePanelHeight(): number {
  const screenHeight =
    typeof window === "undefined" ? 900 : window.screen.availHeight;
  return Math.min(640, screenHeight - 48);
}

interface EdgeSessionPanelProps {
  task: StoredTask;
  onClose: () => void;
  /** Pager controls when the panel is shown from Unread. */
  pager?: EdgePagerControls;
  /** The pager moved here from another item: crossfade the content in. */
  enter?: boolean;
}

/**
 * A compact view of one session beside the toolbar: where it is now (the last
 * few turns), what it is waiting on (its question or approval, answered in
 * place), and a composer for a quick follow-up. Everything else about the
 * session (files, git, the full history) is one click away in the session
 * window via the "Open in chro" button beside the composer.
 */
export function EdgeSessionPanel({
  task,
  onClose,
  pager,
  enter = false,
}: EdgeSessionPanelProps) {
  const { t } = useLanguage();
  const taskId = task.id;

  const {
    taskRuns,
    runsLoading,
    run,
    entries,
    isLoading,
    isStreaming,
    streamingRunId,
    error,
    approvals,
  } = useEdgeConversation(taskId, "edge");
  const taskRunId = run?.id ?? null;
  const tail = useMemo(() => conversationTail(entries, TAIL_TURNS), [entries]);

  const {
    pendingQuestions,
    answerQuestions,
    skipQuestions,
    pendingMcpApproval,
    decideMcpApproval,
  } = useSessionApprovals({ approvals, taskRunId });

  const { isSending, isStopping, handleCancel } = useSessionRunController({
    taskRuns,
    isTaskRunsLoading: runsLoading,
    pendingSubmission: null,
    activeSessionHint: task.active_session_id,
    streamingRunId,
    requestCancelSubmission: noop,
    clearPendingSubmission: noop,
  });

  const diff = useDiffStream({
    taskRunId,
    enabled: Boolean(taskRunId) && !task.worktree_deleted,
    statsOnly: true,
  });
  const { additions, deletions } = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const entry of Object.values(diff.diffs)) {
      additions += entry.additions ?? 0;
      deletions += entry.deletions ?? 0;
    }
    return { additions, deletions };
  }, [diff.diffs]);

  // The panel opens once the conversation is laid out (or failed to load).
  usePanelReady(!isLoading);

  // Shown means read: a finished session leaves Unread once it was seen here.
  useMarkViewedWhenActive(task, true);

  const help = useEdgeToolbarStore((s) => s.help);
  const toggleHelp = useEdgeToolbarStore((s) => s.toggleHelp);
  const projects = useAllProjects(true);
  const projectName = projects[task.project_id]?.name;

  const openInApp = useCallback(
    () => openSessionInApp({ projectId: task.project_id, taskId: task.id }),
    [task.project_id, task.id],
  );
  const title = task.title || t("sessionUnresolved");

  return (
    <EdgePanelContent label={title} enter={enter}>
      <EdgePanelHeader
        title={title}
        pager={pager}
        help={help}
        onToggleHelp={toggleHelp}
        onClose={onClose}
      >
        <SessionStatusLine
          state={panelSessionState(task)}
          agent={task.last_executor}
          projectName={projectName}
        />
        {task.branch ? (
          <BranchLine
            branch={task.branch}
            target={run?.target_branch ?? null}
            additions={additions}
            deletions={deletions}
          />
        ) : null}
      </EdgePanelHeader>

      {help ? (
        <EdgeKeyboardHelp paging={(pager?.order.length ?? 0) > 1} />
      ) : null}
      {/* Hidden, not unmounted, under the help: the draft and scroll stay. */}
      <div
        className={
          help ? "hidden" : "mt-1.5 flex min-h-0 flex-1 flex-col text-[13px]"
        }
      >
        <TaskConversation
          entries={tail}
          isLoading={isLoading}
          error={error}
          isStreaming={isStreaming}
          scrollCacheKey={`edge:${taskId}`}
        />
      </div>

      <div className={help ? "hidden" : "flex flex-col gap-1 px-3 pb-3 pt-1"}>
        {pendingQuestions ? (
          <AgentUserQuestion
            pendingQuestions={pendingQuestions}
            onAnswer={(answers) => void answerQuestions(answers)}
            onSkip={() => void skipQuestions()}
          />
        ) : null}
        {pendingMcpApproval ? (
          <McpToolApproval
            approvalId={pendingMcpApproval.approvalId}
            prompt={pendingMcpApproval.prompt}
            onDecide={(decision) => void decideMcpApproval(decision)}
          />
        ) : null}
        <EdgeComposer
          task={task}
          run={run}
          isSending={isSending}
          isStopping={isStopping}
          onCancel={() => void handleCancel()}
          accessory={
            <button
              type="button"
              title={t("edgeToolbarOpenInApp")}
              aria-label={t("edgeToolbarOpenInApp")}
              onClick={openInApp}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="size-4" />
            </button>
          }
        />
      </div>
    </EdgePanelContent>
  );
}

/**
 * What a panel shows, inside the animated panel frame (`.edge-panel`, owned
 * by the app). `enter` plays the card crossfade when it mounts.
 */
export function EdgePanelContent({
  label,
  height = edgePanelHeight(),
  enter = false,
  children,
}: {
  label: string;
  height?: number;
  enter?: boolean;
  children: ReactNode;
}) {
  // Decided once per mount: later renders must not cut the crossfade short.
  const [entering] = useState(enter);
  return (
    <section
      data-edge-panel-content
      aria-label={label}
      style={{ height }}
      className={cn("flex flex-col", entering && "edge-card-enter")}
    >
      {children}
    </section>
  );
}

const STATUS_LABEL = {
  waiting: "edgeToolbarStatusWaiting",
  running: "edgeToolbarStatusRunning",
  completed: "edgeToolbarStatusFinished",
  failed: "edgeToolbarStatusFailed",
} as const;

/** "Needs your input · project", after the agent's mark and a status dot. */
function SessionStatusLine({
  state,
  agent,
  projectName,
}: {
  state: EdgeSessionState;
  agent: string | null | undefined;
  projectName: string | undefined;
}) {
  const { t } = useLanguage();
  const status = t(STATUS_LABEL[state]);
  return (
    <div className="mt-2 flex h-[18px] min-w-0 items-center gap-2 text-[12px] text-custom-text-300">
      <span className="relative size-[18px] shrink-0">
        {hasAgentLogo(agent) ? (
          <AgentLogo
            agent={agent}
            className="ml-px mt-px size-[13px] text-custom-text-200"
          />
        ) : null}
        <span
          data-status={edgeDotStatus(state)}
          className="edge-state-dot absolute -bottom-0.5 -right-0.5 size-[8.5px] rounded-full ring-[1.5px] ring-custom-background-100"
        />
      </span>
      <span className="truncate">
        {projectName ? `${status} · ${projectName}` : status}
      </span>
    </div>
  );
}

/** The session's branch, its target and its diff, as plain muted text. */
function BranchLine({
  branch,
  target,
  additions,
  deletions,
}: {
  branch: string;
  target: string | null;
  additions: number;
  deletions: number;
}) {
  return (
    <div className="mt-1 flex h-[18px] min-w-0 items-center gap-1.5 text-[11.5px] text-custom-text-300">
      <GitBranch className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{branch}</span>
      {target ? <span className="shrink-0">→ {target}</span> : null}
      {additions > 0 || deletions > 0 ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-500">
            +{additions.toLocaleString()}
          </span>{" "}
          <span className="text-red-500">-{deletions.toLocaleString()}</span>
        </span>
      ) : null}
    </div>
  );
}
