import { OpenAiLogo, PiLogo } from "@/components/agent-logo";
import {
  type BaseCodingAgent,
  type ExecutorInstallInfo,
  fetchExecutorInstallStatus,
} from "@/lib/executor-client";
import { openExecutorInstallGuide } from "@/lib/executor-install";
import { Button } from "@chro/ui/button";
import { Check, GitBranch, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const DEFAULT_INSTALL_STATUS: Record<BaseCodingAgent, ExecutorInstallInfo> = {
  CLAUDE_CODE: {
    installed: false,
    command: "claude",
    resolved_path: null,
    detected_version: null,
  },
  CODEX: {
    installed: false,
    command: "codex",
    resolved_path: null,
    detected_version: null,
  },
  PI: {
    installed: false,
    command: "pi",
    resolved_path: null,
    detected_version: null,
  },
};

const DEFAULT_GIT_INSTALL_STATUS: ExecutorInstallInfo = {
  installed: false,
  command: "git",
  resolved_path: null,
  detected_version: null,
};

type CardState = "checking" | "missing" | "installed";

/**
 * Onboarding step 1: pick a default coding agent.
 *
 * Detection and selection only. Chro neither installs the agent CLIs nor drives
 * their sign-in: each CLI owns those flows, and owning them here meant shipping
 * a second, worse copy that broke on platforms the CLI itself handles fine. A
 * missing agent links out to its own install guide. Availability re-checks on
 * window focus, so a CLI installed in the user's terminal is picked up without
 * restarting onboarding.
 */
export function StepAgent({
  selectedExecutor,
  onSelect,
}: {
  selectedExecutor: BaseCodingAgent | null;
  onSelect: (executor: BaseCodingAgent) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [installStatus, setInstallStatus] = useState<
    Record<BaseCodingAgent, ExecutorInstallInfo>
  >(DEFAULT_INSTALL_STATUS);
  const [gitInstallStatus, setGitInstallStatus] = useState<ExecutorInstallInfo>(
    DEFAULT_GIT_INSTALL_STATUS,
  );

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchExecutorInstallStatus();
      setInstallStatus({
        CLAUDE_CODE: result.claude_code,
        CODEX: result.codex,
        PI: result.pi,
      });
      setGitInstallStatus(result.git);
    } catch {
      setInstallStatus(DEFAULT_INSTALL_STATUS);
      setGitInstallStatus(DEFAULT_GIT_INSTALL_STATUS);
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh on mount and on window focus so an install completed in another
  // terminal reflects without the user retrying anything.
  useEffect(() => {
    void loadStatus();
    const handleFocus = () => void loadStatus();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [loadStatus]);

  const cardStateFor = (installed: boolean): CardState => {
    if (loading) return "checking";
    return installed ? "installed" : "missing";
  };

  const agentDescription = (
    executor: BaseCodingAgent,
    fallback: string,
  ): string => {
    const version = installStatus[executor].detected_version;
    if (version) return `Detected · v${version}`;
    if (!installStatus[executor].installed) return "Not installed";
    return fallback;
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Tools
        </p>
        <ToolCard
          icon={<GitBranch className="size-5 text-muted-foreground" />}
          name="Git"
          description={
            gitInstallStatus.detected_version
              ? `Detected · v${gitInstallStatus.detected_version}`
              : "Version control system"
          }
          state={cardStateFor(gitInstallStatus.installed)}
          onOpenGuide={null}
        />
      </section>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Agent
        </p>
        <AgentCard
          icon={<img src="/icon_claude.png" alt="" className="size-6" />}
          name="Claude Code"
          description={agentDescription("CLAUDE_CODE", "Anthropic CLI agent")}
          state={cardStateFor(installStatus.CLAUDE_CODE.installed)}
          selected={selectedExecutor === "CLAUDE_CODE"}
          onSelect={() => onSelect("CLAUDE_CODE")}
          onOpenGuide={() => void openExecutorInstallGuide("CLAUDE_CODE")}
        />
        <AgentCard
          icon={<OpenAiLogo className="size-5 text-muted-foreground" />}
          name="Codex"
          description={agentDescription("CODEX", "OpenAI CLI agent")}
          state={cardStateFor(installStatus.CODEX.installed)}
          selected={selectedExecutor === "CODEX"}
          onSelect={() => onSelect("CODEX")}
          onOpenGuide={() => void openExecutorInstallGuide("CODEX")}
        />
        <AgentCard
          icon={<PiLogo className="size-5 text-muted-foreground" />}
          name="pi"
          description={agentDescription("PI", "pi CLI agent")}
          state={cardStateFor(installStatus.PI.installed)}
          selected={selectedExecutor === "PI"}
          onSelect={() => onSelect("PI")}
          onOpenGuide={() => void openExecutorInstallGuide("PI")}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Not installed? Follow the agent's own install guide, then come back:
          Chro picks it up automatically. You'll sign in the first time you run
          the agent's CLI.
        </p>
      </section>
    </div>
  );
}

function ToolCard({
  icon,
  name,
  description,
  state,
  onOpenGuide,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  state: CardState;
  onOpenGuide: (() => void) | null;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-custom-border-200 bg-custom-background-90 p-4">
      <div className="flex size-8 shrink-0 items-center justify-center">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      <DetectionStatus state={state} onOpenGuide={onOpenGuide} />
    </div>
  );
}

function AgentCard({
  icon,
  name,
  description,
  state,
  selected,
  onSelect,
  onOpenGuide,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  state: CardState;
  selected: boolean;
  onSelect: () => void;
  onOpenGuide: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border p-4 transition-colors ${
        selected
          ? "border-primary bg-custom-background-80"
          : "border-custom-border-200 bg-custom-background-90 hover:border-custom-border-300"
      }`}
    >
      <button
        type="button"
        className="flex flex-1 items-center gap-3 text-left"
        onClick={onSelect}
      >
        <span
          className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
            selected ? "border-primary" : "border-muted-foreground/40"
          }`}
        >
          {selected ? (
            <span className="size-2 rounded-full bg-primary" />
          ) : null}
        </span>
        <span className="flex size-8 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            {name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {description}
          </span>
        </span>
      </button>
      <DetectionStatus state={state} onOpenGuide={onOpenGuide} />
    </div>
  );
}

/**
 * Right-side detection affordance shared by tool and agent cards. A detected CLI
 * shows a check; a missing one offers its upstream guide, which is the only
 * install path we point at.
 */
function DetectionStatus({
  state,
  onOpenGuide,
}: {
  state: CardState;
  onOpenGuide: (() => void) | null;
}) {
  if (state === "checking") {
    return (
      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
    );
  }
  if (state === "installed") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-500">
        <Check className="size-3.5" />
        Installed
      </span>
    );
  }
  if (!onOpenGuide) {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">
        Not installed
      </span>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={onOpenGuide}
    >
      Install guide
    </Button>
  );
}
