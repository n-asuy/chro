import { AgentLogo, hasAgentLogo } from "@/components/agent-logo";
import { type TranslationKey, useLanguage } from "@/i18n";
import type { StoredTask } from "@/session/types";
import { useAllProjects } from "@/workspace-layout/hooks/use-all-projects";
import { Folder, GitBranch } from "lucide-react";
import { useMemo } from "react";
import type { CapsuleDot, CapsuleDotStatus } from "../domain/capsule-dots";
import { turnPreview } from "../domain/turn-preview";
import { useEdgeConversation } from "../hooks/use-edge-conversation";
import { EdgeDot } from "./edge-dot";
import { usePanelReady } from "./edge-panel-ready";

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
 * that still exists, grouped by project, each row its dot, agent and title.
 * The row under the pointer is previewed beside the list (`data-edge-hover`
 * rows, so the shell reports them while the app is inactive); a click opens
 * the session's compact panel.
 */
export function EdgeSessionList({
  dots,
  previewId,
  onOpenSession,
}: {
  dots: readonly CapsuleDot[];
  previewId: string | null;
  onOpenSession: (taskId: string) => void;
}) {
  const { t } = useLanguage();
  const projectName = useProjectNames();
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
              <button
                key={dot.task.id}
                type="button"
                data-edge-hover={`row:${dot.task.id}`}
                data-previewed={previewId === dot.task.id ? "" : undefined}
                onClick={() => onOpenSession(dot.task.id)}
                className="edge-arow"
              >
                <EdgeDot status={dot.status} index={at} />
                <span className="edge-agent-icon">
                  {hasAgentLogo(dot.task.last_executor) ? (
                    <AgentLogo
                      agent={dot.task.last_executor}
                      className="size-[14px]"
                    />
                  ) : null}
                </span>
                <span className="edge-aname">
                  {dot.task.title || t("sessionUnresolved")}
                </span>
              </button>
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
 * The compact preview beside the list (the mock's preview thread panel): the
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
