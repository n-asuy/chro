import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import {
  fetchAuthStatus,
  triggerAuthLogin,
  updateExecutorProfile,
  type AuthStatusResult,
  type BaseCodingAgent,
} from "@/lib/executor-client";
import { getUiValue, setUiValue, removeUiValue } from "@/lib/ui-state-client";

const EXECUTOR_STORAGE_KEY = "chro:selected-executor";

export const Route = createFileRoute("/")({
  component: ProviderSelectionPage,
});

// LP と同じ OpenAI SVG
function OpenAiIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

type AuthState = "idle" | "checking" | "signed_in" | "signing_in";

function ProviderSelectionPage() {
  const navigate = useNavigate();
  const savedExecutor = getUiValue<string>(EXECUTOR_STORAGE_KEY);
  const hasSavedExecutor =
    savedExecutor === "CLAUDE_CODE" || savedExecutor === "CODEX";

  const [initialLoading, setInitialLoading] = useState(hasSavedExecutor);
  const [selectedExecutor, setSelectedExecutor] = useState<BaseCodingAgent | null>(null);
  const [claudeAuth, setClaudeAuth] = useState<AuthState>("idle");
  const [codexAuth, setCodexAuth] = useState<AuthState>("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const applyStatus = useCallback((status: AuthStatusResult) => {
    setClaudeAuth(status.claude_code.type === "LOGIN_DETECTED" ? "signed_in" : "idle");
    setCodexAuth(status.codex.type === "LOGIN_DETECTED" ? "signed_in" : "idle");
  }, []);

  // On mount: verify saved executor, or fetch initial status
  useEffect(() => {
    if (hasSavedExecutor) {
      fetchAuthStatus()
        .then((status) => {
          const info =
            savedExecutor === "CLAUDE_CODE" ? status.claude_code : status.codex;
          if (info.type === "LOGIN_DETECTED") {
            navigate({ to: "/workspace" });
          } else {
            removeUiValue(EXECUTOR_STORAGE_KEY);
            applyStatus(status);
            setInitialLoading(false);
          }
        })
        .catch(() => {
          removeUiValue(EXECUTOR_STORAGE_KEY);
          setInitialLoading(false);
        });
    } else {
      // Fetch status on load so signed-in agents show immediately
      setClaudeAuth("checking");
      setCodexAuth("checking");
      fetchAuthStatus()
        .then(applyStatus)
        .catch(() => {
          setClaudeAuth("idle");
          setCodexAuth("idle");
        });
    }
    window.desktop?.setWindowMode?.("onboarding");
  }, [navigate, hasSavedExecutor, savedExecutor, applyStatus]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleSignIn = useCallback(async (executor: BaseCodingAgent) => {
    const setAuth = executor === "CLAUDE_CODE" ? setClaudeAuth : setCodexAuth;
    setAuth("signing_in");

    try {
      // The CLI opens the browser automatically; no window.open needed.
      await triggerAuthLogin(executor);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const status = await fetchAuthStatus();
          const info = executor === "CLAUDE_CODE" ? status.claude_code : status.codex;
          if (info.type === "LOGIN_DETECTED") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            applyStatus(status);
            // Auto-select this executor after sign-in
            setSelectedExecutor(executor);
          }
        } catch { /* keep polling */ }
      }, 2000);
      setTimeout(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setAuth("idle");
        }
      }, 300_000);
    } catch {
      setAuth("idle");
    }
  }, [applyStatus]);

  const handleContinue = useCallback(async () => {
    if (!selectedExecutor) return;
    try {
      await updateExecutorProfile({ executor: selectedExecutor, variant: null });
      setUiValue(EXECUTOR_STORAGE_KEY, selectedExecutor);
      navigate({ to: "/workspace" });
    } catch (error) {
      console.error("[onboarding] Failed to set executor", error);
    }
  }, [selectedExecutor, navigate]);

  const canContinue =
    (selectedExecutor === "CLAUDE_CODE" && claudeAuth === "signed_in") ||
    (selectedExecutor === "CODEX" && codexAuth === "signed_in");

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
          {/* Header */}
          <div className="flex flex-col items-center gap-4">
            <img
              src="/logo_chro_invert.png"
              alt="Chro"
              width={140}
              height={37}
              className="h-9 w-auto"
            />
            <p className="text-sm font-light text-white/55">
              Sign in to your coding agent
            </p>
          </div>

          {/* Agent cards */}
          <div className="space-y-3">
            <AgentCard
              icon={<img src="/icon_claude.png" alt="" className="size-8" />}
              name="Claude Code"
              description="Anthropic CLI agent"
              authState={claudeAuth}
              selected={selectedExecutor === "CLAUDE_CODE"}
              onSelect={() => setSelectedExecutor("CLAUDE_CODE")}
              onSignIn={() => handleSignIn("CLAUDE_CODE")}
            />

            <AgentCard
              icon={<OpenAiIcon className="size-7 text-white/60" />}
              name="Codex"
              description="OpenAI CLI agent"
              authState={codexAuth}
              selected={selectedExecutor === "CODEX"}
              onSelect={() => setSelectedExecutor("CODEX")}
              onSignIn={() => handleSignIn("CODEX")}
            />
          </div>

          {/* Continue */}
          <button
            type="button"
            className={
              "w-full py-3 text-sm font-light transition-all " +
              (canContinue
                ? "border border-white/20 bg-white/10 text-white hover:bg-white/15"
                : "border border-white/5 bg-white/[0.03] text-white/20 cursor-not-allowed")
            }
            disabled={!canContinue}
            onClick={handleContinue}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentCard({
  icon,
  name,
  description,
  authState,
  selected,
  onSelect,
  onSignIn,
}: {
  icon: React.ReactNode;
  name: string;
  description: string;
  authState: AuthState;
  selected: boolean;
  onSelect: () => void;
  onSignIn: () => void;
}) {
  const signedIn = authState === "signed_in";

  return (
    <div
      className={
        "flex w-full items-center gap-4 border p-5 transition-colors " +
        (selected
          ? "border-white/25 bg-white/[0.04]"
          : "border-white/10 bg-[#0a0a0a] hover:border-white/15")
      }
    >
      {/* Selectable area */}
      <button
        type="button"
        className="flex flex-1 items-center gap-4 text-left"
        onClick={onSelect}
      >
        {/* Radio */}
        <div className={
          "flex size-4 shrink-0 items-center justify-center rounded-full border " +
          (selected ? "border-white/60" : "border-white/20")
        }>
          {selected ? <div className="size-2 rounded-full bg-white" /> : null}
        </div>

        {/* Icon */}
        <div className="flex size-10 shrink-0 items-center justify-center">
          {icon}
        </div>

        {/* Label */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">{name}</p>
          <p className="text-xs font-light text-white/40">{description}</p>
        </div>
      </button>

      {/* Auth action */}
      <div className="shrink-0">
        {signedIn ? (
          <span className="flex items-center gap-1.5 text-xs font-light text-emerald-400">
            <Check className="size-3.5" />
            Signed in
          </span>
        ) : authState === "checking" ? (
          <Loader2 className="size-4 animate-spin text-white/30" />
        ) : authState === "signing_in" ? (
          <span className="flex items-center gap-1.5 text-xs font-light text-white/40">
            <ExternalLink className="size-3 text-white/30" />
            <Loader2 className="size-3.5 animate-spin" />
          </span>
        ) : (
          <button
            type="button"
            className="border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-light text-white/60 transition-colors hover:bg-white/10 hover:text-white/80"
            onClick={onSignIn}
          >
            Sign in
          </button>
        )}
      </div>
    </div>
  );
}
