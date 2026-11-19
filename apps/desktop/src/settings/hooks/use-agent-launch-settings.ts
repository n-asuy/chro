import {
  type AgentLaunchSettings,
  type AgentLaunchSettingsChange,
  type BaseCodingAgent,
  fetchAgentLaunchSettings,
  updateAgentLaunchSettings,
} from "@/lib/executor-client";
import { useCallback, useEffect, useState } from "react";

const EMPTY: AgentLaunchSettings = {
  launch_args: {},
  question_tool_agents: [],
  question_tool_disabled: [],
};

/** The per-agent launch settings, loaded while the Agents pane is open. */
export function useAgentLaunchSettings(enabled: boolean) {
  const [settings, setSettings] = useState<AgentLaunchSettings>(EMPTY);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetchAgentLaunchSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setLoadError(false);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  /** Rejects with `LaunchArgsRejectedError` when the server refuses it. */
  const update = useCallback(
    async (executor: BaseCodingAgent, change: AgentLaunchSettingsChange) => {
      setSettings(await updateAgentLaunchSettings(executor, change));
    },
    [],
  );

  return { settings, loadError, update };
}
