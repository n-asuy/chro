import { useLanguage } from "@/i18n";
import type {
  BaseCodingAgent,
  ExecutorInstallInfo,
} from "@/lib/executor-client";
import {
  EXECUTOR_INSTALL_GUIDE_URLS,
  installTool,
  openExecutorInstallGuide,
} from "@/lib/executor-install";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@chro/ui/alert-dialog";
import { Button } from "@chro/ui/button";
import { Check, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type ExecutorInstallDialogProps = {
  executor: BaseCodingAgent | null;
  installInfo?: ExecutorInstallInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled?: (executor: BaseCodingAgent) => void;
};

const FALLBACK_COMMANDS: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "claude",
  CODEX: "codex",
  PI: "pi",
};

const EXECUTOR_LABELS: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "Claude Code",
  CODEX: "Codex",
  PI: "pi",
};

export function ExecutorInstallDialog({
  executor,
  installInfo,
  open,
  onOpenChange,
  onInstalled,
}: ExecutorInstallDialogProps) {
  const { t } = useLanguage();
  const [openingGuide, setOpeningGuide] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] =
    useState<ExecutorInstallResult | null>(null);

  const executorLabel = executor ? EXECUTOR_LABELS[executor] : "";
  const expectedCommand = executor
    ? installInfo?.command || FALLBACK_COMMANDS[executor]
    : "";
  const guideUrl = executor ? EXECUTOR_INSTALL_GUIDE_URLS[executor] : "";
  let guideHost = "";
  if (guideUrl) {
    try {
      guideHost = new URL(guideUrl).host;
    } catch {
      guideHost = guideUrl;
    }
  }

  useEffect(() => {
    if (!open || !executor) {
      setInstalling(false);
      setInstallResult(null);
      return;
    }

    let cancelled = false;

    const runInstall = async () => {
      setInstalling(true);
      setInstallResult(null);

      try {
        const result = (await installTool(executor)) as ExecutorInstallResult;
        if (cancelled) {
          return;
        }

        setInstallResult(result);
        setInstalling(false);

        if (result.ok) {
          onInstalled?.(executor);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setInstallResult({
          ok: false,
          executor,
          command: "",
          strategy: "",
          stdout: "",
          stderr: "",
          message:
            error instanceof Error
              ? error.message
              : "Installation request failed.",
        });
        setInstalling(false);
      }
    };

    void runInstall();

    return () => {
      cancelled = true;
    };
  }, [executor, onInstalled, open]);

  const handleOpenGuide = useCallback(async () => {
    if (!executor) {
      return;
    }

    setOpeningGuide(true);
    try {
      await openExecutorInstallGuide(executor);
      onOpenChange(false);
    } catch (error) {
      console.error("[install-dialog] Failed to open install guide", error);
    } finally {
      setOpeningGuide(false);
    }
  }, [executor, onOpenChange]);

  if (!executor) {
    return null;
  }

  const installSucceeded = installResult?.ok === true;
  const installFailed = installResult?.ok === false;
  const strategyLabel = installResult?.strategy || expectedCommand;
  const commandLabel = installResult?.command || expectedCommand;
  const installOutput = installResult?.stderr || installResult?.stdout || "";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border border-border/60 bg-custom-background-100 text-foreground">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-workspace text-[18px]">
            {installSucceeded
              ? t("authInstallDialogSuccessTitle", { executor: executorLabel })
              : installFailed
                ? t("authInstallDialogFailureTitle", {
                    executor: executorLabel,
                  })
                : t("authInstallDialogInstallingTitle", {
                    executor: executorLabel,
                  })}
          </AlertDialogTitle>
          <AlertDialogDescription className="font-workspace text-[13px] leading-6 text-muted-foreground">
            {installSucceeded
              ? t("authInstallDialogSuccessDescription", {
                  executor: executorLabel,
                })
              : installFailed
                ? installResult.message
                : t("authInstallDialogInstallingDescription", {
                    executor: executorLabel,
                  })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-border/60 bg-custom-background-90 p-3">
            <div className="flex items-start gap-3">
              {installSucceeded ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              ) : installFailed ? (
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              ) : (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              )}
              <div className="space-y-2">
                <p className="font-workspace text-[13px] leading-6 text-foreground">
                  {installSucceeded
                    ? t("authInstallDialogSuccessBody")
                    : installFailed
                      ? t("authInstallDialogFailureBody")
                      : t("authInstallDialogInstallingBody")}
                </p>
                <p className="font-workspace text-[12px] leading-5 text-muted-foreground">
                  {installSucceeded
                    ? t("authInstallDialogSuccessNextStep")
                    : t("authInstallDialogSafety")}
                </p>
              </div>
            </div>
          </div>

          <dl className="grid gap-3 rounded-md border border-border/60 bg-custom-background-90 p-3 font-workspace">
            <div className="space-y-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("authInstallDialogMethodLabel")}
              </dt>
              <dd className="text-[13px] text-foreground">{strategyLabel}</dd>
            </div>
            <div className="space-y-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("authInstallDialogCommandLabel")}
              </dt>
              <dd className="font-mono text-[12px] text-foreground break-all">
                {commandLabel}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("authInstallDialogGuideLabel")}
              </dt>
              <dd className="flex items-center gap-2 text-[13px] text-foreground">
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{guideHost}</span>
              </dd>
            </div>
          </dl>

          {installFailed && installOutput ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="font-workspace text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                {t("authInstallDialogErrorLabel")}
              </p>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-amber-900 dark:text-amber-100">
                {installOutput}
              </pre>
            </div>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button
              variant="outline"
              className="font-workspace"
              disabled={openingGuide || installing}
            >
              {installSucceeded
                ? t("authInstallDialogDone")
                : t("authInstallDialogCancel")}
            </Button>
          </AlertDialogCancel>
          {!installSucceeded ? (
            <Button
              className="font-workspace"
              onClick={() => void handleOpenGuide()}
              disabled={openingGuide || installing}
              variant={installFailed ? "default" : "outline"}
            >
              {openingGuide ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="mr-2 h-4 w-4" />
              )}
              {installFailed
                ? t("authInstallDialogOpenGuide")
                : t("authInstallDialogOpenGuideSecondary")}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
