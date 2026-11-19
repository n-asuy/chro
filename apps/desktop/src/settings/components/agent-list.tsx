import { AgentLogo } from "@/components/agent-logo";
import { type TranslationFunction, useLanguage } from "@/i18n";
import type { CliStatus } from "@/lib/cli-status-client";
import { cn } from "@/lib/cn";
import {
  type AgentLaunchSettings,
  type AgentLaunchSettingsChange,
  type BaseCodingAgent,
  LaunchArgsRejectedError,
} from "@/lib/executor-client";
import { openExecutorInstallGuide } from "@/lib/executor-install";
import { Button } from "@chro/ui/button";
import { Switch } from "@chro/ui/switch";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import { useId, useState } from "react";

const AGENTS: ReadonlyArray<{
  executor: BaseCodingAgent;
  cliName: string;
  label: string;
}> = [
  { executor: "CLAUDE_CODE", cliName: "claude", label: "Claude Code" },
  { executor: "CODEX", cliName: "codex", label: "Codex" },
  { executor: "PI", cliName: "pi", label: "pi" },
];

export type AgentListProps = {
  statuses: CliStatus[] | null;
  loading: boolean;
  loadError: boolean;
  onReload: () => void;
  defaultExecutor: BaseCodingAgent | null;
  defaultSaving: boolean;
  onSetDefault: (executor: BaseCodingAgent) => void;
  launchSettings: AgentLaunchSettings;
  /** Rejects with `LaunchArgsRejectedError` when the server refuses it. */
  onUpdateLaunchSettings: (
    executor: BaseCodingAgent,
    change: AgentLaunchSettingsChange,
  ) => Promise<void>;
};

/**
 * Detected agent CLIs, one row each: default choice, install guide, and a
 * disclosure with the resolved executable and the user's launch arguments.
 * Agents that are not on this machine are listed apart with their install hint.
 */
export function AgentList({
  statuses,
  loading,
  loadError,
  onReload,
  defaultExecutor,
  defaultSaving,
  onSetDefault,
  launchSettings,
  onUpdateLaunchSettings,
}: AgentListProps) {
  const { t } = useLanguage();
  const rows = AGENTS.map((agent) => ({
    ...agent,
    status: statuses?.find((status) => status.name === agent.cliName),
  }));
  const installed = rows.filter((row) => row.status?.found);
  const missing = rows.filter((row) => row.status && !row.status.found);

  return (
    <div className="flex flex-col gap-6">
      <section data-section="installed" className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 px-0.5">
          <h3 className="font-workspace flex items-center gap-2 text-[14px] font-semibold text-foreground">
            {t("agentsInstalledTitle")}
            {statuses !== null ? (
              <span className="font-workspace inline-flex items-center rounded-full border border-foreground/20 bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                {t("agentsInstalledCount", { count: installed.length })}
              </span>
            ) : null}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={onReload}
            disabled={loading}
            className="font-workspace h-7 gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:text-foreground"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCcw className="h-3 w-3" />
            )}
            {t("agentsCliStatusRefresh")}
          </Button>
        </div>

        {loadError ? (
          <p
            role="alert"
            className="font-workspace text-[12px] text-destructive"
          >
            {t("agentsCliStatusLoadError")}
          </p>
        ) : null}
        {statuses === null && loading ? (
          <div className="font-workspace flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("agentsCliStatusLoading")}
          </div>
        ) : null}

        <div className="divide-y divide-border/40">
          {installed.map((row) => (
            <InstalledAgentRow
              key={row.executor}
              executor={row.executor}
              cliName={row.cliName}
              label={row.label}
              status={row.status as CliStatus}
              isDefault={defaultExecutor === row.executor}
              defaultSaving={defaultSaving}
              onSetDefault={() => onSetDefault(row.executor)}
              savedArgs={launchSettings.launch_args[row.executor] ?? ""}
              questionTool={
                launchSettings.question_tool_agents.includes(row.executor)
                  ? !launchSettings.question_tool_disabled.includes(
                      row.executor,
                    )
                  : null
              }
              onUpdate={(change) =>
                onUpdateLaunchSettings(row.executor, change)
              }
            />
          ))}
        </div>
      </section>

      {missing.length > 0 ? (
        <section data-section="missing" className="flex flex-col gap-3">
          <h3 className="font-workspace px-0.5 text-[14px] font-semibold text-muted-foreground">
            {t("agentsMissingTitle")}
          </h3>
          <div className="divide-y divide-border/40">
            {missing.map((row) => (
              <div
                key={row.executor}
                data-agent={row.executor}
                className="flex items-start gap-3 py-3 opacity-70"
              >
                <AgentIcon executor={row.executor} />
                <div className="min-w-0 flex-1">
                  <div className="font-workspace text-[14px] leading-none text-foreground">
                    {row.label}
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {row.status?.install_hint}
                  </div>
                </div>
                <GuideButton
                  executor={row.executor}
                  label={t("agentsInstallGuide")}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function AgentIcon({ executor }: { executor: BaseCodingAgent }) {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50 text-foreground">
      <AgentLogo agent={executor} className="h-4 w-4" />
    </div>
  );
}

function GuideButton({
  executor,
  label,
}: {
  executor: BaseCodingAgent;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      onClick={() => openExecutorInstallGuide(executor)}
      className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </Button>
  );
}

type InstalledAgentRowProps = {
  executor: BaseCodingAgent;
  cliName: string;
  label: string;
  status: CliStatus;
  isDefault: boolean;
  defaultSaving: boolean;
  onSetDefault: () => void;
  savedArgs: string;
  /** Whether the question tool is on; `null` for agents without one. */
  questionTool: boolean | null;
  onUpdate: (change: AgentLaunchSettingsChange) => Promise<void>;
};

function InstalledAgentRow({
  executor,
  cliName,
  label,
  status,
  isDefault,
  defaultSaving,
  onSetDefault,
  savedArgs,
  questionTool,
  onUpdate,
}: InstalledAgentRowProps) {
  const { t } = useLanguage();
  // Rows that differ from the defaults start open so an override is never
  // hidden.
  const [open, setOpen] = useState(savedArgs !== "" || questionTool === false);

  return (
    <div data-agent={executor} className="py-3">
      <div className="flex flex-wrap items-start gap-3">
        <AgentIcon executor={executor} />
        <div className="min-w-0 flex-1 sm:min-w-[12rem]">
          <div className="font-workspace text-[14px] leading-none text-foreground">
            {label}
          </div>
          <div
            className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
            title={savedArgs ? `${cliName} ${savedArgs}` : cliName}
          >
            {cliName}
            {savedArgs ? (
              <span className="ml-1.5 text-foreground/70">{savedArgs}</span>
            ) : null}
          </div>
        </div>
        <div className="ml-auto grid shrink-0 grid-cols-[7.5rem_1.75rem_1.75rem] items-center gap-1.5">
          <Button
            variant={isDefault ? "secondary" : "ghost"}
            size="sm"
            disabled={defaultSaving}
            aria-pressed={isDefault}
            onClick={isDefault ? undefined : onSetDefault}
            className="font-workspace h-7 w-full gap-1 whitespace-nowrap rounded-md px-2 text-[12px]"
          >
            {isDefault ? <Check className="h-3 w-3" /> : null}
            {isDefault ? t("agentsIsDefault") : t("agentsSetDefault")}
          </Button>
          <GuideButton executor={executor} label={t("agentsDocs")} />
          <Button
            variant="ghost"
            size="icon"
            aria-expanded={open}
            aria-label={
              open
                ? t("agentsHideLaunchSettings")
                : t("agentsShowLaunchSettings")
            }
            onClick={() => setOpen((value) => !value)}
            className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                open && "rotate-180",
              )}
            />
          </Button>
        </div>
      </div>

      {open ? (
        <div className="mt-3 flex flex-col gap-2 pl-10">
          <ExecutableField status={status} t={t} />
          {questionTool !== null ? (
            <QuestionToolField
              enabled={questionTool}
              onChange={(enabled) => onUpdate({ question_tool: enabled })}
            />
          ) : null}
          {/* Keyed by the saved value so a save elsewhere resets the draft. */}
          <LaunchArgsField
            key={savedArgs}
            savedArgs={savedArgs}
            onSave={(args) => onUpdate({ args })}
          />
          <p className="font-workspace text-[11px] text-muted-foreground">
            {t("agentsLaunchArgsHelp")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ExecutableField({
  status,
  t,
}: {
  status: CliStatus;
  t: TranslationFunction;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-workspace text-[12px] text-muted-foreground">
        {t("agentsExecutableLabel")}
      </span>
      <div
        className="flex h-7 items-center gap-2 rounded-md bg-muted/20 px-3 font-mono text-[12px] text-foreground/80"
        title={status.path ?? undefined}
      >
        <span className="min-w-0 flex-1 truncate">{status.path}</span>
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          {status.version ?? t("agentsCliVersionUnavailable")}
        </span>
      </div>
    </div>
  );
}

function rejectionMessage(error: unknown, t: TranslationFunction): string {
  if (!(error instanceof LaunchArgsRejectedError)) {
    return t("agentsLaunchArgsSaveError");
  }
  switch (error.rejection.code) {
    case "reserved_flag":
      return t("agentsLaunchArgsReservedFlag", { flag: error.rejection.flag });
    case "question_tool_flag":
      return t("agentsLaunchArgsQuestionToolFlag");
    case "unparseable":
      return t("agentsLaunchArgsUnparseable");
  }
}

function QuestionToolField({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
}) {
  const { t } = useLanguage();
  const labelId = useId();
  const [error, setError] = useState<string | null>(null);

  const change = async (next: boolean) => {
    try {
      await onChange(next);
      setError(null);
    } catch (cause) {
      setError(rejectionMessage(cause, t));
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div
            id={labelId}
            className="font-workspace text-[12px] text-foreground"
          >
            {t("agentsQuestionToolLabel")}
          </div>
          <p className="font-workspace text-[11px] text-muted-foreground">
            {t("agentsQuestionToolDescription")}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void change(next)}
          aria-labelledby={labelId}
        />
      </div>
      {error ? (
        <p role="alert" className="font-workspace text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function LaunchArgsField({
  savedArgs,
  onSave,
}: {
  savedArgs: string;
  onSave: (args: string) => Promise<void>;
}) {
  const { t } = useLanguage();
  const errorId = useId();
  const [draft, setDraft] = useState(savedArgs);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: string) => {
    try {
      await onSave(value);
      setError(null);
    } catch (cause) {
      setError(rejectionMessage(cause, t));
    }
  };

  const commit = () => {
    const next = draft.trim();
    if (next === savedArgs) {
      setDraft(savedArgs);
      setError(null);
      return;
    }
    void save(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="font-workspace text-[12px] text-muted-foreground">
        {t("agentsLaunchArgsLabel")}
      </span>
      <div className="flex items-center gap-2">
        <input
          data-field="launch-args"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraft(savedArgs);
              setError(null);
              event.currentTarget.blur();
            }
          }}
          placeholder={t("agentsLaunchArgsPlaceholder")}
          spellCheck={false}
          autoComplete="off"
          aria-label={t("agentsLaunchArgsLabel")}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "h-7 min-w-0 flex-1 rounded-md border border-input bg-input/30 px-3 font-mono text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            error && "border-destructive/50 bg-destructive/5",
          )}
        />
        {savedArgs !== "" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void save("")}
            className="font-workspace h-7 shrink-0 rounded-md px-2 text-[12px] text-muted-foreground hover:text-foreground"
          >
            {t("agentsLaunchArgsReset")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="font-workspace text-[12px] text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
