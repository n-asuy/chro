import { useLanguage } from "@/i18n";
import { getUpdateApi } from "@/lib/desktop-bridge";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  type UpdatePopupView,
  initialModel,
  updateReducer,
} from "./update-popup-reducer";

export type UpdaterActionState =
  | "idle"
  | "downloading"
  | "installing"
  | "retrying";

export interface Updater {
  /** True when the auto-update bridge is present (packaged desktop build). */
  supported: boolean;
  /** Current update lifecycle view, driven by backend status events. */
  view: UpdatePopupView;
  /** In-flight user-initiated action, for spinner/disable states. */
  actionState: UpdaterActionState;
  /** Start downloading an available update. */
  download: () => void;
  /** Install a downloaded update and relaunch. */
  install: () => void;
  /** Re-check the release feed. */
  check: () => void;
}

/**
 * Single owner of the app auto-update lifecycle: subscribes to backend status
 * events, runs the launch-time check, and exposes the view plus the three user
 * actions. Extracted from the header affordance so the release-notes modal and
 * the header chip share one instance and one source of truth.
 *
 * Background-check failures stay silent; errors surface only from a
 * user-initiated download/install/check via the awaited results below.
 */
export function useUpdater(): Updater {
  const { t } = useLanguage();
  const updateApi = useMemo(() => getUpdateApi(), []);
  const [model, dispatch] = useReducer(updateReducer, initialModel);
  const [actionState, setActionState] = useState<UpdaterActionState>("idle");

  useEffect(() => {
    if (!updateApi) return undefined;

    const unsubscribe = updateApi.onStatusChange((status) => {
      if (status.type === "error") return;
      dispatch({ type: "status", status });
    });

    void updateApi.check().catch(() => undefined);

    return () => {
      unsubscribe();
    };
  }, [updateApi]);

  const download = useCallback(async () => {
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

  const install = useCallback(async () => {
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

  const check = useCallback(async () => {
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

  return {
    supported: Boolean(updateApi),
    view: model.view,
    actionState,
    download: () => void download(),
    install: () => void install(),
    check: () => void check(),
  };
}
