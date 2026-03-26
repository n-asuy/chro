import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMergeSettings,
  saveMergeSettings as saveMergeSettingsRequest,
} from "@/lib/preferences-client";
import type { TranslationFunction } from "@/i18n";

const DEFAULT_TEMPLATE =
  "{{title}} (chro {{task_short_id}}){{description_block}}";

type MergeSettingsState = {
  mergeCommitTemplate: string;
  mergeSettingsLoading: boolean;
  mergeSettingsError: string | null;
  mergeSettingsSaveState: "idle" | "saving" | "success" | "error";
  mergeSettingsSaveError: string | null;
  handleTemplateChange: (value: string) => void;
  handleTemplateBlur: () => void;
  handleTemplateReset: () => void;
};

type MergeSettingsArgs = {
  t: TranslationFunction;
};

export function useMergeSettings({ t }: MergeSettingsArgs): MergeSettingsState {
  const [mergeCommitTemplate, setMergeCommitTemplate] =
    useState(DEFAULT_TEMPLATE);
  const [mergeSettingsLoading, setMergeSettingsLoading] = useState(true);
  const [mergeSettingsError, setMergeSettingsError] = useState<string | null>(
    null,
  );
  const [mergeSettingsSaveState, setMergeSettingsSaveState] = useState<
    "idle" | "saving" | "success" | "error"
  >("idle");
  const [mergeSettingsSaveError, setMergeSettingsSaveError] = useState<
    string | null
  >(null);
  const hasLoadedRef = useRef(false);
  const dirtyRef = useRef(false);

  const loadSettings = useCallback(async () => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    setMergeSettingsLoading(true);
    setMergeSettingsError(null);
    try {
      const response = await fetchMergeSettings();
      setMergeCommitTemplate(response.merge_commit_template);
    } catch (error) {
      setMergeSettingsError(
        error instanceof Error ? error.message : "Failed to load merge settings",
      );
    } finally {
      setMergeSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const persistTemplate = useCallback(
    async (template: string) => {
      setMergeSettingsSaveState("saving");
      setMergeSettingsSaveError(null);
      try {
        const trimmed = template.trim();
        await saveMergeSettingsRequest({
          merge_commit_template:
            trimmed === "" || trimmed === DEFAULT_TEMPLATE ? null : trimmed,
        });
        setMergeSettingsSaveState("success");
        setTimeout(() => setMergeSettingsSaveState("idle"), 1500);
      } catch (error) {
        setMergeSettingsSaveState("error");
        setMergeSettingsSaveError(
          error instanceof Error ? error.message : "Failed to save",
        );
      }
    },
    [],
  );

  const handleTemplateChange = useCallback((value: string) => {
    setMergeCommitTemplate(value);
    dirtyRef.current = true;
  }, []);

  const handleTemplateBlur = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setMergeCommitTemplate((current) => {
      void persistTemplate(current);
      return current;
    });
  }, [persistTemplate]);

  const handleTemplateReset = useCallback(() => {
    setMergeCommitTemplate(DEFAULT_TEMPLATE);
    dirtyRef.current = false;
    void persistTemplate(DEFAULT_TEMPLATE);
  }, [persistTemplate]);

  return {
    mergeCommitTemplate,
    mergeSettingsLoading,
    mergeSettingsError,
    mergeSettingsSaveState,
    mergeSettingsSaveError,
    handleTemplateChange,
    handleTemplateBlur,
    handleTemplateReset,
  };
}
