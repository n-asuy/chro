import type { TranslationFunction } from "@/i18n";
import {
  type BaseCodingAgent,
  type ExecutorConfigs,
  type ExecutorProfileId,
  type UpdateExecutorProfileRequest,
  fetchExecutorProfile,
  updateExecutorProfile,
} from "@/lib/executor-client";
import { useCallback, useEffect, useMemo, useState } from "react";

type ExecutorProfileState = {
  executorProfileId: ExecutorProfileId | null;
  executorProfileLoading: boolean;
  executorProfileError: string | null;
  profileSaving: boolean;
  availableExecutors: BaseCodingAgent[];
  handleExecutorSelect: (executor: BaseCodingAgent) => Promise<void>;
};

export function useExecutorProfileSettings({
  t,
}: {
  t: TranslationFunction;
}): ExecutorProfileState {
  const [executorProfileId, setExecutorProfileId] =
    useState<ExecutorProfileId | null>(null);
  const [executorConfigs, setExecutorConfigs] =
    useState<ExecutorConfigs | null>(null);
  const [executorProfileLoading, setExecutorProfileLoading] = useState(true);
  const [executorProfileError, setExecutorProfileError] = useState<
    string | null
  >(null);
  const [profileSaving, setProfileSaving] = useState(false);

  const availableExecutors = useMemo(() => {
    if (!executorConfigs) return [];
    return Object.keys(executorConfigs.executors) as BaseCodingAgent[];
  }, [executorConfigs]);

  const loadExecutorProfile = useCallback(async () => {
    setExecutorProfileLoading(true);
    setExecutorProfileError(null);
    try {
      const response = await fetchExecutorProfile();
      setExecutorProfileId(response.profile);
      setExecutorConfigs(response.profiles);
    } catch (error) {
      setExecutorConfigs(null);
      setExecutorProfileError(
        error instanceof Error ? error.message : t("agentProfileLoadError"),
      );
    } finally {
      setExecutorProfileLoading(false);
    }
  }, [t]);

  const applyExecutorProfileUpdate = useCallback(
    async (changes: UpdateExecutorProfileRequest) => {
      setProfileSaving(true);
      setExecutorProfileError(null);
      try {
        const response = await updateExecutorProfile(changes);
        setExecutorProfileId(response.profile);
        setExecutorConfigs(response.profiles);
      } catch (error) {
        setExecutorProfileError(
          error instanceof Error ? error.message : t("agentProfileSaveError"),
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
      if (!executorProfileId || executorProfileId.executor === executor) return;
      try {
        await applyExecutorProfileUpdate({ executor, variant: null });
      } catch {
        // Errors are surfaced via executorProfileError state.
      }
    },
    [applyExecutorProfileUpdate, executorProfileId],
  );

  useEffect(() => {
    void loadExecutorProfile();
  }, [loadExecutorProfile]);

  return {
    executorProfileId,
    executorProfileLoading,
    executorProfileError,
    profileSaving,
    availableExecutors,
    handleExecutorSelect,
  };
}
