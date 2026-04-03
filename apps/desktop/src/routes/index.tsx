import { ExecutorInstallDialog } from "@/components/dialogs/executor-install-dialog";
import {
  type AvailabilityInfo,
  type BaseCodingAgent,
  type ExecutorInstallInfo,
  fetchAuthStatus,
  fetchExecutorInstallStatus,
  triggerAuthLogin,
  updateExecutorProfile,
} from "@/lib/executor-client";
import { getUiValue, removeUiValue, setUiValue } from "@/lib/ui-state-client";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  },
  CODEX: {
    installed: false,
    command: "codex",
    resolved_path: null,
  },
};

type AgentCardState =
  | "checking"
  | "install"
  | "sign_in"
  | "signing_in"
  | "signed_in";

const getAgentCardState = ({
  executor,
  authStatus,
  installStatus,
  signingInExecutor,
  loading,
}: {
  executor: BaseCodingAgent;
  authStatus: Record<BaseCodingAgent, AvailabilityInfo>;
  installStatus: Record<BaseCodingAgent, ExecutorInstallInfo>;
  signingInExecutor: BaseCodingAgent | null;
  loading: boolean;
}): AgentCardState => {
  if (loading) {
    return "checking";
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

export const Route = createFileRoute("/")({
  component: ProviderSelectionPage,
});

function OpenAiIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function ProviderSelectionPage() {
  const navigate = useNavigate();
  const savedExecutor = getUiValue<string>(EXECUTOR_STORAGE_KEY);
  const hasSavedExecutor =
    savedExecutor === "CLAUDE_CODE" || savedExecutor === "CODEX";

  const [initialLoading, setInitialLoading] = useState(true);
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [selectedExecutor, setSelectedExecutor] =
    useState<BaseCodingAgent | null>(hasSavedExecutor ? savedExecutor : null);
  const [authStatus, setAuthStatus] =
    useState<Record<BaseCodingAgent, AvailabilityInfo>>(DEFAULT_AUTH_STATUS);
  const [installStatus, setInstallStatus] = useState<
    Record<BaseCodingAgent, ExecutorInstallInfo>
  >(DEFAULT_INSTALL_STATUS);
  const [signingInExecutor, setSigningInExecutor] =
    useState<BaseCodingAgent | null>(null);
  const [installDialogExecutor, setInstallDialogExecutor] =
    useState<BaseCodingAgent | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

    setAuthStatus(nextAuthStatus);
    setInstallStatus(nextInstallStatus);
    setAvailabilityLoading(false);

    return {
      authStatus: nextAuthStatus,
      installStatus: nextInstallStatus,
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      const availability = await loadAvailability();
      if (cancelled) {
        return;
      }

      if (hasSavedExecutor) {
        const savedState = getAgentCardState({
          executor: savedExecutor,
          authStatus: availability.authStatus,
          installStatus: availability.installStatus,
          signingInExecutor: null,
          loading: false,
        });

        if (savedState === "signed_in") {
          navigate({ to: "/workspace" });
          return;
        }

        removeUiValue(EXECUTOR_STORAGE_KEY);
      }

      setInitialLoading(false);
    };

    void initialize();
    window.desktop?.setWindowMode?.("onboarding");

    const handleFocus = () => {
      void loadAvailability();
    };

    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
      window.removeEventListener("focus", handleFocus);
    };
  }, [hasSavedExecutor, loadAvailability, navigate, savedExecutor]);

  const handleSignIn = useCallback(
    async (executor: BaseCodingAgent) => {
      setSigningInExecutor(executor);

      try {
        await triggerAuthLogin(executor);
        if (pollRef.current) {
          clearInterval(pollRef.current);
        }
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
              if (pollRef.current) {
                clearInterval(pollRef.current);
              }
              pollRef.current = null;
              setSigningInExecutor(null);
              setSelectedExecutor(executor);
            }
          } catch {
            /* keep polling */
          }
        }, 2000);

        setTimeout(() => {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setSigningInExecutor(null);
          }
        }, 300_000);
      } catch {
        setSigningInExecutor(null);
        void loadAvailability();
      }
    },
    [loadAvailability],
  );

  const handlePrimaryAction = useCallback(
    async (executor: BaseCodingAgent) => {
      const cardState = getAgentCardState({
        executor,
        authStatus,
        installStatus,
        signingInExecutor,
        loading: availabilityLoading,
      });

      if (cardState === "install") {
        setInstallDialogExecutor(executor);
        return;
      }

      if (cardState === "sign_in") {
        await handleSignIn(executor);
      }
    },
    [
      authStatus,
      availabilityLoading,
      handleSignIn,
      installStatus,
      signingInExecutor,
    ],
  );

  const claudeCardState = getAgentCardState({
    executor: "CLAUDE_CODE",
    authStatus,
    installStatus,
    signingInExecutor,
    loading: availabilityLoading,
  });
  const codexCardState = getAgentCardState({
    executor: "CODEX",
    authStatus,
    installStatus,
    signingInExecutor,
    loading: availabilityLoading,
  });

  const canContinue =
    (selectedExecutor === "CLAUDE_CODE" && claudeCardState === "signed_in") ||
    (selectedExecutor === "CODEX" && codexCardState === "signed_in");

  const handleContinue = useCallback(async () => {
    if (!selectedExecutor) return;

    try {
      await updateExecutorProfile({
        executor: selectedExecutor,
        variant: null,
      });
      setUiValue(EXECUTOR_STORAGE_KEY, selectedExecutor);
      navigate({ to: "/workspace" });
    } catch (error) {
      console.error("[onboarding] Failed to set executor", error);
    }
  }, [navigate, selectedExecutor]);

  if (initialLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#181818]">
        <Loader2 className="size-5 animate-spin text-white/40" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <div className="flex flex-1 flex-col items-center justify-center bg-[#181818] px-4">
        <div className="w-full max-w-md space-y-8">
          <div className="flex flex-col items-center gap-4">
            <img
              src="/logo_chro_invert.png"
              alt="Chro"
              width={140}
              height={37}
              className="h-9 w-auto"
            />
            <p className="text-sm font-light text-white/55">
              Install the CLI, then sign in to your coding agent
            </p>
          </div>

          <div className="space-y-3">
            <AgentCard
              icon={<img src="/icon_claude.png" alt="" className="size-8" />}
              name="Claude Code"
              description="Anthropic CLI agent"
              state={claudeCardState}
              selected={selectedExecutor === "CLAUDE_CODE"}
              onSelect={() => setSelectedExecutor("CLAUDE_CODE")}
              onPrimaryAction={() => void handlePrimaryAction("CLAUDE_CODE")}
            />

            <AgentCard
              icon={<OpenAiIcon className="size-7 text-white/60" />}
              name="Codex"
              description="OpenAI CLI agent"
              state={codexCardState}
              selected={selectedExecutor === "CODEX"}
              onSelect={() => setSelectedExecutor("CODEX")}
              onPrimaryAction={() => void handlePrimaryAction("CODEX")}
            />
          </div>

          <button
            type="button"
            className={`w-full py-3 text-sm font-light transition-all ${
              canContinue
                ? "border border-white/20 bg-white/10 text-white hover:bg-white/15"
                : "border border-white/5 bg-white/[0.03] text-white/20 cursor-not-allowed"
            }`}
            disabled={!canContinue}
            onClick={handleContinue}
          >
            Continue
          </button>
        </div>
      </div>
      <ExecutorInstallDialog
        open={installDialogExecutor !== null}
        executor={installDialogExecutor}
        installInfo={
          installDialogExecutor ? installStatus[installDialogExecutor] : null
        }
        onOpenChange={(open) => {
          if (!open) {
            setInstallDialogExecutor(null);
          }
        }}
      />
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
      className={`flex w-full items-center gap-4 border p-5 transition-colors ${
        selected
          ? "border-white/25 bg-white/[0.04]"
          : "border-white/10 bg-[#0a0a0a] hover:border-white/15"
      }`}
    >
      <button
        type="button"
        className="flex flex-1 items-center gap-4 text-left"
        onClick={onSelect}
      >
        <div
          className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
            selected ? "border-white/60" : "border-white/20"
          }`}
        >
          {selected ? <div className="size-2 rounded-full bg-white" /> : null}
        </div>

        <div className="flex size-10 shrink-0 items-center justify-center">
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">{name}</p>
          <p className="text-xs font-light text-white/40">{description}</p>
        </div>
      </button>

      <div className="shrink-0">
        {signedIn ? (
          <span className="flex items-center gap-1.5 text-xs font-light text-emerald-400">
            <Check className="size-3.5" />
            Signed in
          </span>
        ) : state === "checking" ? (
          <Loader2 className="size-4 animate-spin text-white/30" />
        ) : state === "signing_in" ? (
          <span className="flex items-center gap-1.5 text-xs font-light text-white/40">
            <ExternalLink className="size-3 text-white/30" />
            <Loader2 className="size-3.5 animate-spin" />
          </span>
        ) : (
          <button
            type="button"
            className="border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-light text-white/60 transition-colors hover:bg-white/10 hover:text-white/80"
            onClick={onPrimaryAction}
          >
            {state === "install" ? "Install" : "Sign in"}
          </button>
        )}
      </div>
    </div>
  );
}
