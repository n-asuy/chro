import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { getUpdateApi } from "@/lib/desktop-bridge";
import {
  AlertCircle,
  ArrowUpCircle,
  Loader2,
  type LucideIcon,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  formatVersion,
  getReleasePreview,
  initialModel,
  updateReducer,
} from "./update-popup-reducer";

type ActionState = "idle" | "downloading" | "installing" | "retrying";

/**
 * Top-right update affordance. It stays hidden while the app is up to date and
 * surfaces a single, clearly-visible pill the moment an update is available, so
 * the user can update on their own terms instead of being interrupted by a
 * popup. One launch-time check feeds it; backend status events drive the rest.
 *
 * Background-check failures are intentionally swallowed: a release feed hiccup
 * must never leave a nagging error chip in the chrome. Errors only appear in
 * response to a user-initiated download/install/retry, via their awaited
 * results below.
 */
export function UpdateButton() {
  const { t } = useLanguage();
  const updateApi = useMemo(() => getUpdateApi(), []);
  const [model, dispatch] = useReducer(updateReducer, initialModel);
  const [actionState, setActionState] = useState<ActionState>("idle");

  useEffect(() => {
    if (!updateApi) return undefined;

    const unsubscribe = updateApi.onStatusChange((status) => {
      if (status.type === "error") return;
      dispatch({ type: "status", status });
    });

    // Launch-time check. The happy path arrives as status events; a failure
    // here stays silent so the chrome is never cluttered on startup.
    void updateApi.check().catch(() => undefined);

    return () => {
      unsubscribe();
    };
  }, [updateApi]);

  const handleDownload = useCallback(async () => {
    if (!updateApi || model.view.type !== "available") return;
    setActionState("downloading");
    try {
      const result = await updateApi.download();
      if (result.status === "error") {
        dispatch({
          type: "error",
          message: result.error ?? t("updateDownloadError"),
        });
      }
    } catch (error) {
      dispatch({
        type: "error",
        message:
          error instanceof Error ? error.message : t("updateDownloadError"),
      });
    } finally {
      setActionState("idle");
    }
  }, [model.view, t, updateApi]);

  const handleInstall = useCallback(async () => {
    if (!updateApi || model.view.type !== "downloaded") return;
    setActionState("installing");
    try {
      await updateApi.install();
    } catch (error) {
      dispatch({
        type: "error",
        message:
          error instanceof Error ? error.message : t("updateInstallError"),
      });
      setActionState("idle");
    }
  }, [model.view, t, updateApi]);

  const handleRetry = useCallback(async () => {
    if (!updateApi) return;
    setActionState("retrying");
    try {
      const result = await updateApi.check();
      if (result.status === "error") {
        dispatch({
          type: "error",
          message: result.error ?? t("updateCheckError"),
        });
      }
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : t("updateCheckError"),
      });
    } finally {
      setActionState("idle");
    }
  }, [t, updateApi]);

  if (!updateApi || model.view.type === "hidden") return null;

  const { view } = model;
  const isBusy = actionState !== "idle";
  const versionLabel = (version: string | null) =>
    version ? formatVersion(version) : t("updateUnknownVersion");

  let label = "";
  let title = "";
  let icon: LucideIcon = ArrowUpCircle;
  let accent = true;
  let onClick: (() => void) | null = null;

  if (view.type === "available") {
    label = t("updateButtonAvailable");
    title = [
      t("updateAvailableTitle", { version: versionLabel(view.version) }),
      getReleasePreview(view.releaseNotes),
    ]
      .filter(Boolean)
      .join("\n");
    onClick = () => {
      void handleDownload();
    };
  } else if (view.type === "downloading") {
    label = t("updateButtonDownloading", { percent: Math.round(view.percent) });
    title = label;
    icon = Loader2;
  } else if (view.type === "downloaded") {
    label = t("updateRestartButton");
    title = t("updateDownloadedTitle", { version: versionLabel(view.version) });
    icon = RotateCcw;
    onClick = () => {
      void handleInstall();
    };
  } else if (view.type === "error") {
    label = t("updateRetryButton");
    title = view.message;
    icon = AlertCircle;
    accent = false;
    onClick = () => {
      void handleRetry();
    };
  }

  const spinning = isBusy || view.type === "downloading";
  const Icon = spinning ? Loader2 : icon;

  return (
    <button
      type="button"
      onClick={onClick ?? undefined}
      disabled={onClick === null || isBusy}
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
