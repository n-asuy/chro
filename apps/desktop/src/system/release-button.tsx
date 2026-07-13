import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import {
  AlertCircle,
  ArrowUpCircle,
  Loader2,
  type LucideIcon,
  RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { CURRENT_VERSION } from "./changelog";
import { ReleaseNotesModal } from "./release-notes-modal";
import { formatVersion } from "./update-popup-reducer";
import { type Updater, useUpdater } from "./use-updater";

/**
 * Header release affordances: an always-visible version chip that opens the
 * release-notes / changelog modal, plus a sibling update button that only
 * appears when there is something to do (download / restart / retry). The two
 * stay side by side so "what's in this build" and "a new build is ready" read as
 * related but distinct controls.
 */
export function ReleaseButton() {
  const { t } = useLanguage();
  const updater = useUpdater();
  const [open, setOpen] = useState(false);

  const versionLabel = CURRENT_VERSION
    ? formatVersion(CURRENT_VERSION)
    : t("releaseNotesTitle");

  return (
    <>
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label={t("releaseNotesTitle")}
              className={cn(
                "ml-1 inline-flex h-6 shrink-0 items-center rounded-md px-2",
                "font-workspace text-[11px] font-medium tabular-nums",
                "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              )}
            >
              {versionLabel}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center">
            {t("releaseNotesTitle")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <UpdateActionButton updater={updater} />

      <ReleaseNotesModal open={open} onOpenChange={setOpen} updater={updater} />
    </>
  );
}

/**
 * The update prompt proper: hidden until the auto-updater has an actionable
 * state, then a single accent pill that drives download → restart (or offers a
 * retry after an error). Sits immediately right of the version chip.
 */
function UpdateActionButton({ updater }: { updater: Updater }) {
  const { t } = useLanguage();
  const { view, actionState } = updater;
  const busy = actionState !== "idle";
  const versionLabel = (version: string | null) =>
    version ? formatVersion(version) : t("updateUnknownVersion");

  let label: string;
  let title: string;
  let icon: LucideIcon = ArrowUpCircle;
  let accent = true;
  let onClick: (() => void) | null = null;

  if (view.type === "available") {
    label = t("updateButtonAvailable");
    title = t("updateAvailableTitle", { version: versionLabel(view.version) });
    onClick = updater.download;
  } else if (view.type === "downloading") {
    label = t("updateButtonDownloading", { percent: Math.round(view.percent) });
    title = label;
    icon = Loader2;
  } else if (view.type === "downloaded") {
    label = t("updateRestartButton");
    title = t("updateDownloadedTitle", { version: versionLabel(view.version) });
    icon = RotateCcw;
    onClick = updater.install;
  } else if (view.type === "error") {
    label = t("updateRetryButton");
    title = view.message;
    icon = AlertCircle;
    accent = false;
    onClick = updater.check;
  } else {
    return null;
  }

  const spinning = busy || view.type === "downloading";
  const Icon = spinning ? Loader2 : icon;

  return (
    <button
      type="button"
      onClick={onClick ?? undefined}
      disabled={onClick === null || busy}
      title={title}
      aria-label={title || label}
      className={cn(
        "ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2",
        "font-workspace text-[11px] font-medium",
        accent
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-60",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", spinning && "animate-spin")} />
      <span className="max-w-[140px] truncate">{label}</span>
    </button>
  );
}
