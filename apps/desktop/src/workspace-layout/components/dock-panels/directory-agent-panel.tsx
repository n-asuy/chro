import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  type LedgerEntry,
  type LedgerOutcome,
  fetchDirectoryAgent,
} from "@/lib/directory-map-client";
import { useInboxTasksStream } from "@/session/hooks";
import { formatRelativeTime } from "@/session/lib/relative-time";
import type { StoredTask } from "@/session/types";
import { useQuery } from "@tanstack/react-query";
import { Archive, Check, FileText, GitMerge, SquarePen, X } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { useOpenSession } from "../../hooks/use-open-session";
import { useProjectNavigation } from "../../hooks/use-project-navigation";
import { useOpenProjectsStore } from "../../state/open-projects-store";
import { useRightDockStore } from "../../state/right-dock-store";

/**
 * The standing agent of one directory (the right dock's `agent` panel).
 *
 * Three things, nothing else: the brief file that governs the directory
 * (opened as a file tab, edited in the repo so every harness reads it), the
 * ledger of finished sessions addressed there, and the entry point for a new
 * session scoped to it. The subject comes from the right-dock store, set by
 * the Map or by a session's home chip.
 */
export function DirectoryAgentDockPanel() {
  const { t } = useLanguage();
  const target = useRightDockStore((s) => s.agentTarget);
  const projects = useOpenProjectsStore((s) => s.projects);
  const project = target
    ? projects.find((entry) => entry.id === target.projectId) ?? null
    : null;
  const openSession = useOpenSession();
  const { newSession, openProjectFile } = useProjectNavigation();

  // The ledger changes whenever a homed session finishes; key the query on
  // those rows so it refetches with the stream instead of polling.
  const { tasks } = useInboxTasksStream(Boolean(target));
  const homedVersion = useMemo(() => {
    if (!target) return "";
    return tasks
      .filter(
        (task) =>
          task.project_id === target.projectId && task.home_dir === target.path,
      )
      .map((task) => `${task.id}:${task.status}:${task.updated_at}`)
      .join("|");
  }, [tasks, target]);

  const { data } = useQuery({
    queryKey: [
      "directory-agent",
      target?.projectId,
      target?.path,
      homedVersion,
    ],
    queryFn: () => fetchDirectoryAgent(target!.projectId, target!.path),
    enabled: Boolean(target),
    staleTime: 10_000,
  });

  const openBrief = useCallback(
    (path: string) => {
      if (project) openProjectFile(project, path);
    },
    [openProjectFile, project],
  );

  const openLedgerEntry = useCallback(
    (entry: LedgerEntry) => {
      if (!target) return;
      const streamed = tasks.find((task) => task.id === entry.taskId);
      const task: StoredTask = streamed ?? {
        id: entry.taskId,
        slug: entry.slug,
        project_id: target.projectId,
        title: entry.title,
        status: entry.outcome,
        created_at: entry.updatedAt,
        updated_at: entry.updatedAt,
        sort_order: 0,
      };
      openSession(task);
    },
    [openSession, target, tasks],
  );

  if (!target) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-custom-sidebar-text-400">
        {t("directoryAgentSelect")}
      </div>
    );
  }

  const crumbs = target.path ? target.path.split("/") : [];
  const brief = data?.brief ?? null;
  const inherited = data?.inheritedBrief ?? null;
  const ledger = data?.ledger ?? [];

  return (
    <div className="font-workspace text-[12px] leading-[1.35] flex h-full flex-col overflow-y-auto px-2 pb-3 text-custom-sidebar-text-100">
      <div className="px-1.5 pb-2 pt-0.5 font-mono text-[12px] text-custom-sidebar-text-400">
        <span
          className={cn(crumbs.length === 0 && "text-custom-sidebar-text-100")}
        >
          {project?.name ?? t("projectRoot")}
        </span>
        {crumbs.map((segment, index) => (
          <span key={`${index}:${segment}`}>
            <span className="mx-1">/</span>
            <span
              className={cn(
                index === crumbs.length - 1 && "text-custom-sidebar-text-100",
              )}
            >
              {segment}
            </span>
          </span>
        ))}
      </div>

      <SectionLabel>{t("directoryAgentBrief")}</SectionLabel>
      {brief ? (
        <FileRow onClick={() => openBrief(brief.path)}>{brief.path}</FileRow>
      ) : inherited ? (
        <FileRow muted onClick={() => openBrief(inherited.path)}>
          {t("directoryAgentInherits", { path: inherited.path })}
        </FileRow>
      ) : (
        <div className="py-1.5 pl-2.5 text-custom-sidebar-text-400">
          {t("directoryAgentNoBrief")}
        </div>
      )}

      <SectionLabel>{t("directoryAgentLedger")}</SectionLabel>
      {ledger.length === 0 ? (
        <div className="py-1.5 pl-2.5 text-custom-sidebar-text-400">
          {t("directoryAgentNoOutcomes")}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {ledger.map((entry) => (
            <button
              key={entry.taskId}
              type="button"
              onClick={() => openLedgerEntry(entry)}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/5"
            >
              <OutcomeGlyph outcome={entry.outcome} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] text-custom-sidebar-text-100">
                  {entry.title}
                </span>
                <span className="truncate text-[11px] text-custom-sidebar-text-400">
                  {outcomeLabel(entry.outcome, t)}
                  {" · "}
                  {formatRelativeTime(entry.updatedAt)}
                  {entry.summary ? ` · ${entry.summary}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          disabled={!project}
          onClick={() => project && newSession(project, target.path)}
          className="group flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] text-custom-sidebar-text-300 transition hover:bg-foreground/5 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40"
        >
          <SquarePen className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">
            {t("directoryAgentNewSession")}
          </span>
        </button>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 flex h-6 items-center px-1.5 text-[11px] font-medium uppercase tracking-wide text-custom-sidebar-text-400">
      {children}
    </div>
  );
}

function FileRow({
  muted = false,
  onClick,
  children,
}: {
  muted?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[28px] w-full items-center gap-1.5 rounded-md px-2.5 text-left text-[12px] transition-colors hover:bg-foreground/5",
        muted
          ? "text-custom-sidebar-text-400 hover:text-custom-sidebar-text-200"
          : "text-custom-sidebar-text-200 hover:text-custom-sidebar-text-100",
      )}
    >
      <FileText className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function OutcomeGlyph({ outcome }: { outcome: LedgerOutcome }) {
  const className = "mt-0.5 size-3.5 shrink-0";
  switch (outcome) {
    case "merged":
      return <GitMerge className={cn(className, "text-emerald-600")} />;
    case "completed":
      return <Check className={cn(className, "text-emerald-600")} />;
    case "failed":
      return <X className={cn(className, "text-red-500")} />;
    case "archived":
      return (
        <Archive className={cn(className, "text-custom-sidebar-text-400")} />
      );
  }
}

function outcomeLabel(
  outcome: LedgerOutcome,
  t: ReturnType<typeof useLanguage>["t"],
): string {
  switch (outcome) {
    case "merged":
      return t("ledgerOutcomeMerged");
    case "completed":
      return t("ledgerOutcomeCompleted");
    case "failed":
      return t("ledgerOutcomeFailed");
    case "archived":
      return t("ledgerOutcomeArchived");
  }
}
