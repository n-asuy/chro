import { type TranslationKey, useLanguage } from "@/i18n";
import {
  type AgentSkillState,
  CHRO_SKILL_INSTALL_COMMAND,
} from "@/lib/agent-skill-client";
import { cn } from "@/lib/cn";
import type { useAgentSkill } from "@/settings/hooks/use-agent-skill";
import { Button } from "@chro/ui/button";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";

type AgentSkill = ReturnType<typeof useAgentSkill>;

const STATE_LABEL: Record<AgentSkillState, TranslationKey> = {
  installed: "agentSkillStateInstalled",
  not_installed: "agentSkillStateNotInstalled",
  outdated: "agentSkillStateOutdated",
  conflict: "agentSkillStateConflict",
  no_agent: "agentSkillStateNoAgent",
  unavailable: "agentSkillStateUnavailable",
};

function StateIcon({ state }: { state: AgentSkillState }) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (state) {
    case "installed":
      return <CheckCircle2 className={cn(className, "text-emerald-500")} />;
    case "outdated":
    case "conflict":
      return <AlertTriangle className={cn(className, "text-amber-500")} />;
    case "not_installed":
      return <XCircle className={cn(className, "text-muted-foreground")} />;
    case "no_agent":
    case "unavailable":
      return <MinusCircle className={cn(className, "text-muted-foreground")} />;
  }
}

/**
 * State line + Install/Update for the agent skill. Shared by onboarding and
 * the title-bar Agent status menu so both read the same dry-run report. It
 * never offers to overwrite a conflict: whatever is in the way belongs to the
 * person, so it is named and left alone.
 */
export function AgentSkillInstallControl({
  skill,
  compact = false,
  hideInstall = false,
}: {
  skill: AgentSkill;
  compact?: boolean;
  /** The host installs it itself (onboarding's Continue). */
  hideInstall?: boolean;
}) {
  const { t } = useLanguage();
  const { available, report, state, loading, busy, error, install } = skill;
  const textSize = compact ? "text-[11px]" : "text-xs";

  if (!available) {
    return (
      <div className={cn("space-y-1 text-muted-foreground", textSize)}>
        <p>{t("agentSkillInstallByHand")}</p>
        <code className="block rounded border border-border/60 bg-muted/40 px-1.5 py-1 font-mono text-[11px] text-foreground/90">
          {CHRO_SKILL_INSTALL_COMMAND}
        </code>
      </div>
    );
  }

  if (report === null && loading) {
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 text-muted-foreground",
          textSize,
        )}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("agentSkillChecking")}
      </div>
    );
  }

  const action =
    hideInstall || (state !== "not_installed" && state !== "outdated")
      ? null
      : state;
  const blocked =
    report?.targets.filter((target) => target.outcome === "conflict") ?? [];

  return (
    <div className={cn("space-y-1", textSize)}>
      <div className="flex items-center gap-1.5">
        <StateIcon state={state} />
        <span className="font-medium text-foreground">
          {t(STATE_LABEL[state])}
        </span>
        {action ? (
          <span className="ml-auto">
            <Button
              variant={action === "not_installed" ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() => void install()}
              className={cn(compact && "h-6 px-2 text-[11px]")}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {action === "not_installed"
                ? t("agentSkillInstall")
                : t("agentSkillUpdate")}
            </Button>
          </span>
        ) : null}
      </div>
      {state === "installed" && report ? (
        <p className="truncate text-muted-foreground">{report.skill}</p>
      ) : null}
      {blocked.map((target) => (
        <p key={target.path} className="text-muted-foreground">
          <span className="font-mono">{target.path}</span>
          {target.detail ? `: ${target.detail}` : null}
        </p>
      ))}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}
