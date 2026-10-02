import {
  type CliInstallStatus,
  getCliInstallApi,
} from "@/lib/cli-install-client";
import { useCallback, useEffect, useState } from "react";

/**
 * Registration state of the bundled `chro` command plus the install/remove
 * actions. `available` is false in the web build, where there is nothing to
 * register. Re-probes on window focus so a change made from a terminal (or the
 * admin prompt) is reflected without a manual refresh.
 */
export function useCliInstall(enabled = true) {
  const api = getCliInstallApi();
  const available = api !== undefined;
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      setStatus(await api.status());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Resolves with the resulting status, or null when the action failed, so a
  // caller sequencing on it (onboarding's Continue) can decide without
  // waiting for a re-render.
  const perform = useCallback(
    async (action: "install" | "remove"): Promise<CliInstallStatus | null> => {
      if (!api || busy) return null;
      setBusy(true);
      setError(null);
      try {
        const next = await api[action]();
        setStatus(next);
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, busy],
  );

  const install = useCallback(() => perform("install"), [perform]);
  const remove = useCallback(() => perform("remove"), [perform]);

  useEffect(() => {
    if (!enabled || !available) return undefined;
    void reload();
    const handleFocus = () => void reload();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [available, enabled, reload]);

  return { available, status, loading, busy, error, reload, install, remove };
}
