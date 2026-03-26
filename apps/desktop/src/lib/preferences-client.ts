import { desktopFetch } from "./backend-client";

type PreferencesResponse = {
  preferences: {
    language: "en" | "ja";
    show_hidden_entries: boolean;
    analytics_enabled: boolean;
    telemetry_id: string;
  };
};

export type AppTheme = "light" | "dark";

export type EditorConfig = {
  font_size: number;
  line_height: number;
  vim_mode: boolean;
  theme: AppTheme;
};

type EditorConfigResponse = {
  editor: EditorConfig;
};

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  font_size: 15,
  line_height: 1.6,
  vim_mode: false,
  theme: "light",
};

export const fetchPreferences = async (): Promise<PreferencesResponse> => {
  return desktopFetch<PreferencesResponse>("/rpc/preferences");
};

export const savePreferences = async (payload: {
  language: "en" | "ja";
  show_hidden_entries?: boolean;
  analytics_enabled?: boolean;
}): Promise<PreferencesResponse> => {
  return desktopFetch<PreferencesResponse>("/rpc/preferences", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
};

export type MergeSettingsResponse = {
  merge_commit_template: string;
};

export const fetchMergeSettings =
  async (): Promise<MergeSettingsResponse> => {
    return desktopFetch<MergeSettingsResponse>("/rpc/preferences/merge");
  };

export const saveMergeSettings = async (payload: {
  merge_commit_template: string | null;
}): Promise<MergeSettingsResponse> => {
  return desktopFetch<MergeSettingsResponse>("/rpc/preferences/merge", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

export const fetchEditorConfig = async (): Promise<EditorConfigResponse> => {
  return desktopFetch<EditorConfigResponse>("/rpc/preferences/editor");
};

export const saveEditorConfig = async (
  payload: Partial<EditorConfig>,
): Promise<EditorConfigResponse> => {
  return desktopFetch<EditorConfigResponse>("/rpc/preferences/editor", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
};
