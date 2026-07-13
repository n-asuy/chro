import { type CliStatus, fetchCliStatus } from "@/lib/cli-status-client";
import { useCallback, useEffect, useState } from "react";

export function useAgentCliStatus(enabled: boolean) {
  const [statuses, setStatuses] = useState<CliStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetchCliStatus();
      setStatuses(response.agents);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled) return undefined;

    const handleFocus = () => void reload();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [enabled, reload]);

  return { statuses, loading, error, reload };
}
