import { OpenAiLogo } from "@/components/agent-logo";
import { useLanguage } from "@/i18n";
import {
  type AvailabilityInfo,
  type BaseCodingAgent,
  type ExecutorInstallInfo,
  type InstallableTool,
  fetchAuthStatus,
  fetchExecutorInstallStatus,
  triggerAuthLogin,
  updateExecutorProfile,
} from "@/lib/executor-client";
import { installTool } from "@/lib/executor-install";
import { setUiValue } from "@/lib/ui-state-client";
import { Button } from "@chro/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chro/ui/dialog";
import { Check, GitBranch, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useAutoOpenSetupOnboarding,
  useSetupOnboardingStore,
} from "./use-setup-onboarding";

const EXECUTOR_STORAGE_KEY = "chro:selected-executor";

const DEFAULT_AUTH_STATUS: Record<BaseCodingAgent, AvailabilityInfo> = {
  CLAUDE_CODE: { type: "NOT_FOUND" },
  CODEX: { type: "NOT_FOUND" },
};

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
};

const DEFAULT_GIT_INSTALL_STATUS: ExecutorInstallInfo = {
  installed: false,
  command: "git",
  resolved_path: null,
  detected_version: null,
};

type AgentCardState =
  | "checking"
  | "install"
  | "installing"
  | "sign_in"
  | "signing_in"
  | "signed_in";

type ToolCardState = "checking" | "install" | "installing" | "installed";

const getAgentCardState = ({
  executor,
  authStatus,
  installStatus,
  installingTool,
  signingInExecutor,
  loading,
}: {
  executor: BaseCodingAgent;
  authStatus: Record<BaseCodingAgent, AvailabilityInfo>;
  installStatus: Record<BaseCodingAgent, ExecutorInstallInfo>;
  installingTool: InstallableTool | null;
  signingInExecutor: BaseCodingAgent | null;
  loading: boolean;
}): AgentCardState => {
  if (loading) {
    return "checking";
  }

  if (installingTool === executor) {
    return "installing";
  }

  if (signingInExecutor === executor) {
    return "signing_in";
  }

  if (!installStatus[executor].installed) {
    return "install";
  }

  if (authStatus[executor].type === "LOGIN_DETECTED") {
    return "signed_in";
  }

  return "sign_in";
};

const getToolCardState = ({
  installed,
  installingTool,
  tool,
  loading,
}: {
  installed: boolean;
  installingTool: InstallableTool | null;
  tool: InstallableTool;
  loading: boolean;
}): ToolCardState => {
  if (loading) return "checking";
  if (installingTool === tool) return "installing";
  if (installed) return "installed";
  return "install";
};

/**
 * First-launch onboarding presented as a themed overlay dialog: checks that git
 * and a coding agent (Claude Code / Codex) are installed and signed in. Mounted
 * globally so it floats above whatever route is active. Owns no navigation —
 * dismissing it simply reveals the app underneath.
 */
export function SetupModal() {
  const { t } = useLanguage();
  const isOpen = useSetupOnboardingStore((s) => s.isOpen);
  const complete = useSetupOnboardingStore((s) => s.complete);

  useAutoOpenSetupOnboarding();

  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [selectedExecutor, setSelectedExecutor] =
    useState<BaseCodingAgent | null>(null);
  const [authStatus, setAuthStatus] =
    useState<Record<BaseCodingAgent, AvailabilityInfo>>(DEFAULT_AUTH_STATUS);
  const [installStatus, setInstallStatus] = useState<
    Record<BaseCodingAgent, ExecutorInstallInfo>
  >(DEFAULT_INSTALL_STATUS);
  const [gitInstallStatus, setGitInstallStatus] = useState<ExecutorInstallInfo>(
    DEFAULT_GIT_INSTALL_STATUS,
  );
  const [installingTool, setInstallingTool] = useState<InstallableTool | null>(
    null,
  );
  const [signingInExecutor, setSigningInExecutor] =
    useState<BaseCodingAgent | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAuthPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  const loadAvailability = useCallback(async () => {
    setAvailabilityLoading(true);

    const [authResult, installResult] = await Promise.allSettled([
      fetchAuthStatus(),
      fetchExecutorInstallStatus(),
    ]);

    const nextAuthStatus =
      authResult.status === "fulfilled"
        ? {
            CLAUDE_CODE: authResult.value.claude_code,
            CODEX: authResult.value.codex,
          }
        : DEFAULT_AUTH_STATUS;

    const nextInstallStatus =
      installResult.status === "fulfilled"
        ? {
            CLAUDE_CODE: installResult.value.claude_code,
            CODEX: installResult.value.codex,
          }
        : DEFAULT_INSTALL_STATUS;

    const nextGitInstallStatus =
      installResult.status === "fulfilled"
        ? installResult.value.git
        : DEFAULT_GIT_INSTALL_STATUS;

    setAuthStatus(nextAuthStatus);
    setInstallStatus(nextInstallStatus);
    setGitInstallStatus(nextGitInstallStatus);
    setAvailabilityLoading(false);
  }, []);

  // Refresh availability whenever the modal opens (and on window focus while
  // open) so installs/sign-ins completed in another terminal reflect quickly.
  useEffect(() => {
    if (!isOpen) return;

    void loadAvailability();

    const handleFocus = () => {
      void loadAvailability();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [isOpen, loadAvailability]);

  useEffect(() => {
    return () => {
      clearAuthPolling();
    };
  }, [clearAuthPolling]);

  const handleInstall = useCallback(
    async (tool: InstallableTool) => {
      setInstallingTool(tool);
      try {
        const result = await installTool(tool);
        if (result.ok) {
          await loadAvailability();
        }
      } catch {
        /* install failed */
      } finally {
        setInstallingTool(null);
      }
    },
    [loadAvailability],
  );

  const handleSignIn = useCallback(
    async (executor: BaseCodingAgent) => {
      setSigningInExecutor(executor);

      try {
        await triggerAuthLogin(executor);
        clearAuthPolling();
        pollRef.current = setInterval(async () => {
          try {
            const status = await fetchAuthStatus();
            const nextAuthStatus = {
              CLAUDE_CODE: status.claude_code,
              CODEX: status.codex,
            } satisfies Record<BaseCodingAgent, AvailabilityInfo>;
            setAuthStatus(nextAuthStatus);

            const info =
              executor === "CLAUDE_CODE" ? status.claude_code : status.codex;
            if (info.type === "LOGIN_DETECTED") {
              clearAuthPolling();
              setSigningInExecutor(null);
              setSelectedExecutor(executor);
            }
          } catch {
            /* keep polling */
          }
        }, 2000);

        pollTimeoutRef.current = setTimeout(() => {
          clearAuthPolling();
          setSigningInExecutor(null);
        }, 300_000);
      } catch {
        clearAuthPolling();
        setSigningInExecutor(null);
        void loadAvailability();
      }
    },
    [clearAuthPolling, loadAvailability],
  );

  const handleAgentPrimaryAction = useCallback(
    async (executor: BaseCodingAgent) => {
      const cardState = getAgentCardState({
        executor,
        authStatus,
        installStatus,
        installingTool,
        signingInExecutor,
        loading: availabilityLoading,
      });

      if (cardState === "install") {
        await handleInstall(executor);
        return;
      }

      if (cardState === "sign_in") {
        await handleSignIn(executor);
      }
    },
    [
      authStatus,
      availabilityLoading,
      handleInstall,
      handleSignIn,
      installStatus,
      installingTool,
      signingInExecutor,
    ],
  );

  const claudeCardState = getAgentCardState({
    executor: "CLAUDE_CODE",
    authStatus,
    installStatus,
    installingTool,
    signingInExecutor,
    loading: availabilityLoading,
  });
  const codexCardState = getAgentCardState({
    executor: "CODEX",
    authStatus,
    installStatus,
    installingTool,
    signingInExecutor,
    loading: availabilityLoading,
  });
  const gitCardState = getToolCardState({
    installed: gitInstallStatus.installed,
    installingTool,
    tool: "GIT",
    loading: availabilityLoading,
  });

  const canContinue =
    (selectedExecutor === "CLAUDE_CODE" && claudeCardState === "signed_in") ||
    (selectedExecutor === "CODEX" && codexCardState === "signed_in");
  const gitDescription = gitInstallStatus.detected_version
    ? t("authDetectedVersion", {
        version: gitInstallStatus.detected_version,
      })
    : "Version control system";
  const claudeDescription = installStatus.CLAUDE_CODE.detected_version
    ? t("authDetectedVersion", {
        version: installStatus.CLAUDE_CODE.detected_version,
      })
    : "Anthropic CLI agent";
  const codexDescription = installStatus.CODEX.detected_version
    ? t("authDetectedVersion", {
        version: installStatus.CODEX.detected_version,
      })
    : "OpenAI CLI agent";

  const handleContinue = useCallback(async () => {
    if (!selectedExecutor) return;

    try {
      await updateExecutorProfile({
        executor: selectedExecutor,
        variant: null,
      });
      setUiValue(EXECUTOR_STORAGE_KEY, selectedExecutor);
    } catch (error) {
      console.error("[onboarding] Failed to set executor", error);
    } finally {
      clearAuthPolling();
      setSigningInExecutor(null);
      complete();
    }
  }, [clearAuthPolling, complete, selectedExecutor]);

  const handleDismiss = useCallback(() => {
    clearAuthPolling();
    setSigningInExecutor(null);
    complete();
  }, [clearAuthPolling, complete]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) handleDismiss();
      }}
    >
      <DialogContent className="max-w-md border-custom-border-200 bg-custom-background-100 text-foreground">
        <DialogHeader>
          <DialogTitle>Set up Chro</DialogTitle>
          <DialogDescription>
            Install the CLI and sign in to your coding agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Tools
            </p>
            <ToolCard
              icon={<GitBranch className="size-5 text-muted-foreground" />}
              name="Git"
              description={gitDescription}
              state={gitCardState}
              onInstall={() => void handleInstall("GIT")}
            />
          </section>

          <section className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Agent
            </p>
            <AgentCard
              icon={<img src="/icon_claude.png" alt="" className="size-6" />}
              name="Claude Code"
              description={claudeDescription}
              state={claudeCardState}
              selected={selectedExecutor === "CLAUDE_CODE"}
              onSelect={() => setSelectedExecutor("CLAUDE_CODE")}
              onPrimaryAction={() =>
                void handleAgentPrimaryAction("CLAUDE_CODE")
              }
            />
            <AgentCard
              icon={<OpenAiLogo className="size-5 text-muted-foreground" />}
              name="Codex"
              description={codexDescription}
              state={codexCardState}
              selected={selectedExecutor === "CODEX"}
              onSelect={() => setSelectedExecutor("CODEX")}
              onPrimaryAction={() => void handleAgentPrimaryAction("CODEX")}
            />
          </section>
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={handleDismiss}>
            Skip for now
          </Button>
          <Button onClick={handleContinue} disabled={!canContinue}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToolCard({
  icon,
  name,
  description,
  state,
  onInstall,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  state: ToolCardState;
  onInstall: () => void;
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

      <div className="shrink-0">
        {state === "installed" ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
            <Check className="size-3.5" />
            Installed
          </span>
        ) : state === "checking" || state === "installing" ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <Button variant="outline" size="sm" onClick={onInstall}>
            Install
          </Button>
        )}
      </div>
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
  onPrimaryAction,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  state: AgentCardState;
  selected: boolean;
  onSelect: () => void;
  onPrimaryAction: () => void;
}) {
  const signedIn = state === "signed_in";

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

      <div className="shrink-0">
        {signedIn ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
            <Check className="size-3.5" />
            Signed in
          </span>
        ) : state === "checking" ||
          state === "signing_in" ||
          state === "installing" ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <Button variant="outline" size="sm" onClick={onPrimaryAction}>
            {state === "install" ? "Install" : "Sign in"}
          </Button>
        )}
      </div>
    </div>
  );
}
