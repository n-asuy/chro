import {
  type AgentSkillState,
  type SkillInstallReport,
  agentSkillState,
  getAgentSkillApi,
} from "@/lib/agent-skill-client";
import { useCallback, useEffect, useState } from "react";

/**
 * Whether the agent skill is installed, plus the install action. `available`
 * is false in the web build, which has no bundled CLI to run. The probe is a
 * dry run and writes nothing; re-probes on window focus so a change made from
 * a terminal shows without a refresh.
 */
export function useAgentSkill(enabled = true) {
  const api = getAgentSkillApi();
  const available = api !== undefined;
  const [report, setReport] = useState<SkillInstallReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      setReport(await api.status());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Resolves with the state after installing, or null when it failed, so a
  // caller sequencing on it (onboarding's Continue) can decide at once.
  const install = useCallback(async (): Promise<AgentSkillState | null> => {
    if (!api || busy) return null;
    setBusy(true);
    setError(null);
    try {
      await api.install();
      const next = await api.status();
      setReport(next);
      return agentSkillState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [api, busy]);

  useEffect(() => {
    if (!enabled || !available) return undefined;
    void reload();
    const handleFocus = () => void reload();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [available, enabled, reload]);

  return {
    available,
    report,
    state: agentSkillState(report),
    loading,
    busy,
    error,
    reload,
    install,
  };
}
