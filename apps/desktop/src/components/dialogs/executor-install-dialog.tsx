import { useLanguage } from "@/i18n";
import type {
  BaseCodingAgent,
  ExecutorInstallInfo,
} from "@/lib/executor-client";
import {
  EXECUTOR_INSTALL_GUIDE_URLS,
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
import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

type ExecutorInstallDialogProps = {
  executor: BaseCodingAgent | null;
  installInfo?: ExecutorInstallInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const FALLBACK_COMMANDS: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "claude",
  CODEX: "codex",
};

const EXECUTOR_LABELS: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "Claude Code",
  CODEX: "Codex",
};

export function ExecutorInstallDialog({
  executor,
  installInfo,
  open,
  onOpenChange,
}: ExecutorInstallDialogProps) {
  const { t } = useLanguage();
  const [openingGuide, setOpeningGuide] = useState(false);

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

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border border-border/60 bg-custom-background-100 text-foreground">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-workspace text-[18px]">
            {t("authInstallDialogTitle", { executor: executorLabel })}
          </AlertDialogTitle>
          <AlertDialogDescription className="font-workspace text-[13px] leading-6 text-muted-foreground">
            {t("authInstallDialogDescription", { executor: executorLabel })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-border/60 bg-custom-background-90 p-3">
            <p className="font-workspace text-[13px] leading-6 text-foreground">
              {t("authInstallDialogBody")}
            </p>
            <p className="mt-2 font-workspace text-[12px] leading-5 text-muted-foreground">
              {t("authInstallDialogSafety")}
            </p>
          </div>

          <dl className="grid gap-3 rounded-md border border-border/60 bg-custom-background-90 p-3 font-workspace">
            <div className="space-y-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("authInstallDialogGuideLabel")}
              </dt>
              <dd className="flex items-center gap-2 text-[13px] text-foreground">
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{guideHost}</span>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("authInstallDialogCommandLabel")}
              </dt>
              <dd className="font-mono text-[12px] text-foreground">
                {expectedCommand}
              </dd>
            </div>
          </dl>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button
              variant="outline"
              className="font-workspace"
              disabled={openingGuide}
            >
              {t("authInstallDialogCancel")}
            </Button>
          </AlertDialogCancel>
          <Button
            className="font-workspace"
            onClick={() => void handleOpenGuide()}
            disabled={openingGuide}
          >
            {openingGuide ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="mr-2 h-4 w-4" />
            )}
            {t("authInstallDialogOpenGuide")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
