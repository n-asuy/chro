import { type TranslationKey, useLanguage } from "@/i18n";
import {
  type CliInstallAttention,
  cliInstallAttention,
  cliInstallCanRemove,
  cliInstallPrimaryAction,
} from "@/lib/cli-install-client";
import { cn } from "@/lib/cn";
import type { useCliInstall } from "@/settings/hooks/use-cli-install";
import { Button } from "@chro/ui/button";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";

type CliInstall = ReturnType<typeof useCliInstall>;

const STATE_LABEL: Record<CliInstallAttention, TranslationKey> = {
  ready: "chroCliStateReady",
  needs_install: "chroCliStateNeedsInstall",
  needs_repair: "chroCliStateNeedsRepair",
  needs_path: "chroCliStateNeedsPath",
  blocked: "chroCliStateBlocked",
  unsupported: "chroCliStateUnsupported",
};

function StateIcon({ attention }: { attention: CliInstallAttention }) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (attention) {
    case "ready":
      return <CheckCircle2 className={cn(className, "text-emerald-500")} />;
    case "needs_path":
    case "needs_repair":
      return <AlertTriangle className={cn(className, "text-amber-500")} />;
    case "blocked":
      return <XCircle className={cn(className, "text-destructive")} />;
    case "unsupported":
      return <MinusCircle className={cn(className, "text-muted-foreground")} />;
    case "needs_install":
      return <XCircle className={cn(className, "text-muted-foreground")} />;
  }
}

/**
 * State line + install/repair/remove buttons for the bundled `chro` command.
 * Shared by Settings, onboarding, and the title-bar CLI menu so every surface
 * reads the same status and offers the same actions. Callers own the hook so
 * they can also react to the state (menu badge, onboarding gating).
 */
export function ChroCliInstallControl({
  cli,
  compact = false,
  hidePrimaryAction = false,
}: {
  cli: CliInstall;
  compact?: boolean;
  /** The host performs install/repair itself (onboarding's Continue). */
  hidePrimaryAction?: boolean;
}) {
  const { t } = useLanguage();
  const { status, loading, busy, error, install, remove } = cli;

  if (status === null) {
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 text-muted-foreground",
          compact ? "text-[11px]" : "text-xs",
        )}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <MinusCircle className="h-3.5 w-3.5" />
        )}
        {loading ? t("chroCliChecking") : (error ?? t("chroCliStateUnsupported"))}
      </div>
    );
  }

  const attention = cliInstallAttention(status);
  const primary = hidePrimaryAction ? null : cliInstallPrimaryAction(status);
  const canRemove = cliInstallCanRemove(status);
  const detail = error ?? status.detail;

  return (
    <div className={cn("space-y-1", compact ? "text-[11px]" : "text-xs")}>
      <div className="flex items-center gap-1.5">
        <StateIcon attention={attention} />
        <span className="font-medium text-foreground">
          {t(STATE_LABEL[attention])}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {primary ? (
            <Button
              variant={primary === "install" ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() => void install()}
              className={cn(compact && "h-6 px-2 text-[11px]")}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {primary === "install" ? t("chroCliInstall") : t("chroCliRepair")}
            </Button>
          ) : null}
          {canRemove ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              className={cn(
                "text-muted-foreground",
                compact && "h-6 px-2 text-[11px]",
              )}
            >
              {t("chroCliRemove")}
            </Button>
          ) : null}
        </span>
      </div>
      {status.commandPath ? (
        <p className="truncate font-mono text-muted-foreground" title={status.commandPath}>
          {status.commandPath}
        </p>
      ) : null}
      {detail ? (
        <p className={cn("leading-snug", error ? "text-destructive" : "text-muted-foreground")}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}
