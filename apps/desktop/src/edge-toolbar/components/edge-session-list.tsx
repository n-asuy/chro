import { AgentLogo, hasAgentLogo } from "@/components/agent-logo";
import { type TranslationKey, useLanguage } from "@/i18n";
import type { StoredTask } from "@/session/types";
import { useAllProjects } from "@/workspace-layout/hooks/use-all-projects";
import { Folder, GitBranch, Mic } from "lucide-react";
import { useMemo } from "react";
import type { CapsuleDot, CapsuleDotStatus } from "../domain/capsule-dots";
import { taskIcon } from "../domain/task-icons";
import { turnPreview } from "../domain/turn-preview";
import { useEdgeVoiceActions } from "../hooks/edge-voice-actions";
import { useEdgeConversation } from "../hooks/use-edge-conversation";
import { EdgeDot } from "./edge-dot";
import { usePanelReady } from "./edge-panel-ready";
import { EdgeTaskIcon } from "./edge-task-icon";

const AGENT_LABEL: Record<string, TranslationKey> = {
  CLAUDE_CODE: "mcpExecutorOptionClaude",
  CODEX: "mcpExecutorOptionCodex",
  PI: "mcpExecutorOptionPi",
};

function useProjectNames(): (projectId: string) => string {
  const projects = useAllProjects(true);
  return (projectId) => projects[projectId]?.name ?? "";
}

/** Sessions grouped by project, groups in the order their first session appeared. */
function groupByProject(dots: readonly CapsuleDot[]) {
  const groups = new Map<string, CapsuleDot[]>();
  for (const dot of dots) {
    const group = groups.get(dot.task.project_id);
    if (group) group.push(dot);
    else groups.set(dot.task.project_id, [dot]);
  }
  return [...groups.entries()];
}

/**
 * The session list the capsule opens (the mock's agents panel): every session
 * that still exists, grouped by project, each row its dot, icon and title,
 * and a microphone that talks to that session (shown on the highlighted
 * row, as the mock's row actions). The row under the pointer is previewed
 * beside the list (`data-edge-hover` rows, so the shell reports them while
 * the app is inactive); a click opens the session's compact panel, the
 * context menu opens it with its icon picker.
 */
export function EdgeSessionList({
  dots,
  previewId,
  onOpenSession,
  onPickIcon,
}: {
  dots: readonly CapsuleDot[];
  previewId: string | null;
  onOpenSession: (taskId: string) => void;
  onPickIcon: (taskId: string) => void;
}) {
  const { t } = useLanguage();
  const projectName = useProjectNames();
  const voice = useEdgeVoiceActions();
  const groups = useMemo(() => groupByProject(dots), [dots]);
  usePanelReady(true);
  let index = 0;
  return (
    <section
      aria-label={t("edgeToolbarSessions")}
      className="edge-agents"
      data-edge-panel-content
    >
      {groups.map(([projectId, group]) => (
        <div key={projectId} className="edge-agroup-block">
          <div className="edge-agroup">{projectName(projectId)}</div>
          {group.map((dot) => {
            const at = index++;
            return (
              <div
                key={dot.task.id}
                data-edge-hover={`row:${dot.task.id}`}
                data-edge-row={dot.task.id}
                data-previewed={previewId === dot.task.id ? "" : undefined}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onPickIcon(dot.task.id);
                }}
                className="edge-arow"
              >
                <button
                  type="button"
                  onClick={() => onOpenSession(dot.task.id)}
                  className="edge-arow-open"
                >
                  <EdgeDot status={dot.status} index={at} />
                  <span className="edge-row-icon">
                    <EdgeTaskIcon name={taskIcon(dot.task.icon)} />
                  </span>
                  <span className="edge-aname">
                    {dot.task.title || t("sessionUnresolved")}
                  </span>
                </button>
                <span className="edge-arow-acts">
                  <button
                    type="button"
                    title={t("edgeToolbarTalkToSession")}
                    aria-label={t("edgeToolbarTalkToSession")}
                    data-edge-talk-to={dot.task.id}
                    onClick={() => voice.talkTo(dot.task.id)}
                    className="edge-arow-act"
                  >
                    <Mic />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

const STATUS_LABEL: Record<
  Exclude<CapsuleDotStatus, "waiting">,
  TranslationKey
> = {
  running: "edgeToolbarStatusRunning",
  done: "edgeToolbarStatusFinished",
  idle: "edgeToolbarStatusIdle",
};

function statusLabel(
  task: StoredTask,
  status: CapsuleDotStatus,
): TranslationKey {
  if (status !== "waiting") return STATUS_LABEL[status];
  return task.awaiting_input
    ? "edgeToolbarStatusWaiting"
    : "edgeToolbarStatusFailed";
}

/**
 * A session's compact preview (the mock's preview thread panel), shown beside
 * the list for the row under the pointer and beside the capsule for the tile
 * under it; it only reads, never marks the session read. The
 * session's title, agent, project and state; its last turn's request, tool
 * calls on one line and latest reply; a live status; its folder and branch.
 */
export function EdgeSessionPreview({
  task,
  status,
}: {
  task: StoredTask;
  status: CapsuleDotStatus;
}) {
  const { t } = useLanguage();
  const projectName = useProjectNames()(task.project_id);
  const { entries, isLoading } = useEdgeConversation(task.id, "edge-preview");
  const turn = useMemo(() => turnPreview(entries), [entries]);
  usePanelReady(!isLoading);

  const agentKey = task.last_executor
    ? AGENT_LABEL[task.last_executor]
    : undefined;
  const agent = agentKey ? t(agentKey) : null;
  const sub = [agent, projectName, t(statusLabel(task, status))]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      aria-label={task.title}
      className="edge-tp"
      data-edge-panel-content
    >
      <div className="edge-tp-head">
        <span className="edge-agent-icon">
          {hasAgentLogo(task.last_executor) ? (
            <AgentLogo agent={task.last_executor} className="size-[14px]" />
          ) : null}
        </span>
        <div className="edge-tp-titles">
          <div className="edge-tp-title">
            {task.title || t("sessionUnresolved")}
          </div>
          <div className="edge-tp-sub">{sub}</div>
        </div>
      </div>
      <div className="edge-tp-log">
        {turn.request ? (
          <div className="edge-su-user">{turn.request}</div>
        ) : null}
        {agent && (turn.tools || turn.reply) ? (
          <div className="edge-su-ran">
            {t("edgeToolbarRunWith")}
            <b>{agent}</b>
          </div>
        ) : null}
        {turn.tools ? <div className="edge-su-tool">$ {turn.tools}</div> : null}
        {turn.reply ? <p className="edge-su-reply">{turn.reply}</p> : null}
        {status === "running" ? (
          <div className="edge-su-status">
            <span className="edge-su-spin" />
            {t("edgeToolbarStatusRunning")}
          </div>
        ) : task.awaiting_input ? (
          <div className="edge-su-status">{t("edgeToolbarStatusWaiting")}</div>
        ) : null}
      </div>
      <div className="edge-tp-foot">
        <span>
          <Folder aria-hidden="true" />
          {projectName}
        </span>
        {task.branch ? (
          <>
            <span className="edge-tp-sep" />
            <span>
              <GitBranch aria-hidden="true" />
              {task.branch}
            </span>
          </>
        ) : null}
      </div>
    </section>
  );
}
