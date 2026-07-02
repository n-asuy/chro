import type { TranslationFunction } from "@/i18n";
import {
  type BaseCodingAgent,
  type ClaudeExecutionMode,
  type ExecutorConfigs,
  type ExecutorProfileId,
  type UpdateExecutorProfileRequest,
  detectClaudeVersion,
  fetchExecutorProfile,
  updateExecutorProfile,
} from "@/lib/executor-client";
import { useCallback, useEffect, useMemo, useState } from "react";

type ClaudeVersionData = {
  version: string | null;
  command: string | null;
  resolvedPath: string | null;
};

type ExecutorProfileState = {
  claudeVersionInfo: ClaudeVersionData | null;
  claudeVersionLoading: boolean;
  claudeVersionError: string | null;
  claudeVersionFetchedAtLabel: string | null;
  executorProfileId: ExecutorProfileId | null;
  executorConfigs: ExecutorConfigs | null;
  executorProfileLoading: boolean;
  executorProfileError: string | null;
  profileSaving: boolean;
  profileSaveState: "idle" | "saving" | "success" | "error";
  availableExecutors: BaseCodingAgent[];
  availableVariants: string[];
  currentExecutorLabel: string;
  claudeExecutionMode: ClaudeExecutionMode;
  handleExecutorSelect: (executor: BaseCodingAgent) => Promise<void>;
  handleVariantSelect: (variant: string) => Promise<void>;
  handleClaudeExecutionModeSelect: (
    mode: ClaudeExecutionMode,
  ) => Promise<void>;
  handleClaudeVersionReload: () => void;
  handleExecutorProfileReload: () => void;
};

export function useExecutorProfileSettings({
  t,
}: {
  t: TranslationFunction;
}): ExecutorProfileState {
  const [claudeVersionInfo, setClaudeVersionInfo] =
    useState<ClaudeVersionData | null>(null);
  const [claudeVersionLoading, setClaudeVersionLoading] = useState(true);
  const [claudeVersionError, setClaudeVersionError] = useState<string | null>(
    null,
  );
  const [claudeVersionFetchedAt, setClaudeVersionFetchedAt] = useState<
    string | null
  >(null);
  const [executorProfileId, setExecutorProfileId] =
    useState<ExecutorProfileId | null>(null);
  const [executorConfigs, setExecutorConfigs] =
    useState<ExecutorConfigs | null>(null);
  const [executorProfileLoading, setExecutorProfileLoading] = useState(true);
  const [executorProfileError, setExecutorProfileError] = useState<
    string | null
  >(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaveState, setProfileSaveState] = useState<
    "idle" | "saving" | "success" | "error"
  >("idle");
  const [claudeExecutionMode, setClaudeExecutionMode] =
    useState<ClaudeExecutionMode>("pty");

  const claudeVersionFetchedAtLabel = useMemo(() => {
    if (!claudeVersionFetchedAt) return null;
    try {
      return new Date(claudeVersionFetchedAt).toLocaleString();
    } catch {
      return claudeVersionFetchedAt;
    }
  }, [claudeVersionFetchedAt]);

  // Get available executors from configs
  const availableExecutors = useMemo(() => {
    if (!executorConfigs) return [];
    return Object.keys(executorConfigs.executors) as BaseCodingAgent[];
  }, [executorConfigs]);

  // Get available variants for current executor
  const availableVariants = useMemo(() => {
    if (!executorConfigs || !executorProfileId) return [];
    const executorConfig =
      executorConfigs.executors[executorProfileId.executor];
    if (!executorConfig) return [];
    return Object.keys(executorConfig);
  }, [executorConfigs, executorProfileId]);

  // Current executor display name
  const currentExecutorLabel = useMemo(() => {
    if (!executorProfileId) return t("claudeModelUnknown");
    const executor = executorProfileId.executor;
    const variant = executorProfileId.variant || "DEFAULT";
    return `${executor} / ${variant}`;
  }, [executorProfileId, t]);

  const loadClaudeVersion = useCallback(async () => {
    setClaudeVersionLoading(true);
    setClaudeVersionError(null);

    try {
      const response = await detectClaudeVersion();
      const timestamp = new Date().toISOString();
      if (response.ok) {
        setClaudeVersionInfo({
          version: response.version ?? null,
          command: response.command ?? null,
          resolvedPath: response.resolved_path ?? null,
        });
        setClaudeVersionFetchedAt(timestamp);
      } else {
        setClaudeVersionInfo({
          version: null,
          command: response.command ?? null,
          resolvedPath: response.resolved_path ?? null,
        });
        setClaudeVersionError(response.message ?? t("claudeVersionFetchError"));
        setClaudeVersionFetchedAt(timestamp);
      }
    } catch (error) {
      setClaudeVersionInfo(null);
      setClaudeVersionError(
        error instanceof Error ? error.message : t("claudeVersionFetchError"),
      );
      setClaudeVersionFetchedAt(new Date().toISOString());
    } finally {
      setClaudeVersionLoading(false);
    }
  }, [t]);

  const loadExecutorProfile = useCallback(async () => {
    setExecutorProfileLoading(true);
    setExecutorProfileError(null);
    try {
      const response = await fetchExecutorProfile();
      setExecutorProfileId(response.profile);
      setExecutorConfigs(response.profiles);
      setClaudeExecutionMode(response.claude_execution_mode);
    } catch (error) {
      setExecutorConfigs(null);
      setExecutorProfileError(
        error instanceof Error ? error.message : t("claudeModelLoadError"),
      );
    } finally {
      setExecutorProfileLoading(false);
    }
  }, [t]);

  const applyExecutorProfileUpdate = useCallback(
    async (changes: UpdateExecutorProfileRequest) => {
      setProfileSaveState("saving");
      setProfileSaving(true);
      setExecutorProfileError(null);
      try {
        const response = await updateExecutorProfile(changes);
        setExecutorProfileId(response.profile);
        setExecutorConfigs(response.profiles);
        setClaudeExecutionMode(response.claude_execution_mode);
        setProfileSaveState("success");
        setTimeout(() => {
          setProfileSaveState((prev) => (prev === "success" ? "idle" : prev));
        }, 2000);
      } catch (error) {
        setProfileSaveState("error");
        setExecutorProfileError(
          error instanceof Error ? error.message : t("claudeModelSaveError"),
        );
        throw error;
      } finally {
        setProfileSaving(false);
      }
    },
    [t],
  );

  const handleExecutorSelect = useCallback(
    async (executor: BaseCodingAgent) => {
      if (!executorProfileId || executorProfileId.executor === executor) {
        return;
      }
      try {
        await applyExecutorProfileUpdate({ executor, variant: null });
      } catch {
        // Errors are surfaced via executorProfileError state
      }
    },
    [applyExecutorProfileUpdate, executorProfileId],
  );

  const handleVariantSelect = useCallback(
    async (variant: string) => {
      if (!executorProfileId) return;
      const currentVariant = executorProfileId.variant || "DEFAULT";
      if (currentVariant === variant) return;
      try {
        await applyExecutorProfileUpdate({ variant });
      } catch {
        // Errors are surfaced via executorProfileError state
      }
    },
    [applyExecutorProfileUpdate, executorProfileId],
  );

  const handleClaudeExecutionModeSelect = useCallback(
    async (mode: ClaudeExecutionMode) => {
      if (claudeExecutionMode === mode) return;
      try {
        await applyExecutorProfileUpdate({ claude_execution_mode: mode });
      } catch {
        // Errors are surfaced via executorProfileError state
      }
    },
    [applyExecutorProfileUpdate, claudeExecutionMode],
  );

  const handleExecutorProfileReload = useCallback(() => {
    void loadExecutorProfile();
  }, [loadExecutorProfile]);

  const handleClaudeVersionReload = useCallback(() => {
    void loadClaudeVersion();
  }, [loadClaudeVersion]);

  useEffect(() => {
    void loadClaudeVersion();
  }, [loadClaudeVersion]);

  useEffect(() => {
    void loadExecutorProfile();
  }, [loadExecutorProfile]);

  return {
    claudeVersionInfo,
    claudeVersionLoading,
    claudeVersionError,
    claudeVersionFetchedAtLabel,
    executorProfileId,
    executorConfigs,
    executorProfileLoading,
    executorProfileError,
    profileSaving,
    profileSaveState,
    availableExecutors,
    availableVariants,
    currentExecutorLabel,
    claudeExecutionMode,
    handleExecutorSelect,
    handleVariantSelect,
    handleClaudeExecutionModeSelect,
    handleClaudeVersionReload,
    handleExecutorProfileReload,
  };
}
