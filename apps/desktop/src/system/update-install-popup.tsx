import { Button } from "@chro/ui/button";
import { Loader2, RefreshCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { useLanguage } from "@/i18n";
import { getUpdateApi, getVersion } from "@/lib/desktop-bridge";
import {
  formatVersion,
  getReleasePreview,
  initialModel,
  updateReducer,
} from "./update-popup-reducer";

type ActionState = "idle" | "downloading" | "installing" | "retrying";

export function UpdateInstallPopup() {
  const { t } = useLanguage();
  const updateApi = useMemo(() => getUpdateApi(), []);

  const [model, dispatch] = useReducer(updateReducer, initialModel);
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fallbackVersion =
      typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim().length > 0
        ? __APP_VERSION__.trim()
        : null;

    const loadVersion = async () => {
      const getDesktopVersion = getVersion();
      if (!getDesktopVersion) {
        if (!cancelled && fallbackVersion) {
          setCurrentVersion(formatVersion(fallbackVersion));
        }
        return;
      }
      try {
        const version = await getDesktopVersion();
        if (!cancelled) {
          setCurrentVersion(formatVersion(version));
        }
      } catch {
        if (!cancelled && fallbackVersion) {
          setCurrentVersion(formatVersion(fallbackVersion));
        }
      }
    };

    void loadVersion();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!updateApi) return undefined;

    const unsubscribe = updateApi.onStatusChange((status) => {
      dispatch({ type: "status", status });
    });

    return () => {
      unsubscribe();
    };
  }, [updateApi]);

  const versionLabel = useCallback(
    (version: string | null) => {
      if (!version) return t("updateUnknownVersion");
      return formatVersion(version);
    },
    [t],
  );

  const handleDismiss = useCallback(() => {
    dispatch({ type: "dismiss" });
    setActionState("idle");
  }, []);

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
        message:
          error instanceof Error ? error.message : t("updateCheckError"),
      });
    } finally {
      setActionState("idle");
    }
  }, [t, updateApi]);

  if (!updateApi || model.view.type === "hidden") return null;

  const { view } = model;
  const releasePreview =
    view.type === "available" ? getReleasePreview(view.releaseNotes) : null;

  const isBusy = actionState !== "idle";
  let title = "";
  let description = "";
  let primaryLabel = "";
  let onPrimaryAction: (() => void) | null = null;

  if (view.type === "available") {
    const nextVersion = versionLabel(view.version);
    title = t("updateAvailableTitle", { version: nextVersion });
    description = t("updateAvailableDescription");
    primaryLabel = t("updateInstallButton", { version: nextVersion });
    onPrimaryAction = () => {
      void handleDownload();
    };
  }

  if (view.type === "downloading") {
    const nextVersion = versionLabel(view.version);
    title = t("updateDownloadingTitle", { version: nextVersion });
    description = t("updateDownloadingDescription", {
      percent: Math.round(view.percent),
    });
  }

  if (view.type === "downloaded") {
    const nextVersion = versionLabel(view.version);
    title = t("updateDownloadedTitle", { version: nextVersion });
    description = t("updateDownloadedDescription");
    primaryLabel = t("updateRestartButton");
    onPrimaryAction = () => {
      void handleInstall();
    };
  }

  if (view.type === "error") {
    title = t("updateErrorTitle");
    description = view.message;
    primaryLabel = t("updateRetryButton");
    onPrimaryAction = () => {
      void handleRetry();
    };
  }

  return (
    <div className="pointer-events-none fixed bottom-16 right-4 z-[120] flex w-[340px] justify-end">
      <div className="pointer-events-auto w-full rounded-xl border border-border/60 bg-custom-background-100 p-3 shadow-[0_12px_36px_rgba(0,0,0,0.18)]">
        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="space-y-1">
              <p className="font-workspace text-[13px] font-semibold text-foreground">
                {title}
              </p>
              <p className="font-workspace text-[12px] text-muted-foreground">
                {description}
              </p>
              {currentVersion ? (
                <p className="font-workspace text-[11px] text-muted-foreground">
                  {t("updateCurrentVersion", { version: currentVersion })}
                </p>
              ) : null}
              {releasePreview ? (
                <p className="font-workspace line-clamp-2 text-[11px] text-muted-foreground">
                  {releasePreview}
                </p>
              ) : null}
            </div>

            {view.type === "downloading" ? (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-150"
                  style={{
                    width: `${Math.round(view.percent)}%`,
                  }}
                />
              </div>
            ) : null}

            <div className="flex items-center gap-1.5">
              {onPrimaryAction ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={onPrimaryAction}
                  disabled={isBusy}
                  className="font-workspace h-8 text-[11px]"
                >
                  {isBusy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {primaryLabel}
                </Button>
              ) : null}
              {view.type === "available" || view.type === "downloaded" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleDismiss}
                  className="font-workspace h-8 text-[11px]"
                >
                  {t("updateLaterButton")}
                </Button>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            onClick={handleDismiss}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label={t("updateDismissButton")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {view.type === "error" ? (
          <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
            <RefreshCcw className="h-3 w-3" />
            <span className="font-workspace">{t("updateRetryHint")}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
