import { desktopFetch } from "./backend-client";

type PreferencesResponse = {
  preferences: {
    language: "en" | "ja";
    show_hidden_entries: boolean;
    analytics_enabled: boolean;
    telemetry_id: string;
  };
};

export type AppTheme = "light" | "dark" | "system";

export type EditorConfig = {
  font_size: number;
  line_height: number;
  vim_mode: boolean;
};

type EditorConfigResponse = {
  editor: EditorConfig;
};

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  font_size: 15,
  line_height: 1.6,
  vim_mode: false,
};

export type AppearanceConfig = {
  theme: AppTheme;
  /**
   * User-chosen accent seed as a `#rrggbb` hex string. Absent/null follows the
   * built-in brand accent. Sending `null` resets to brand; the per-mode
   * readability clamp is applied at derivation time, not on this seed.
   */
  accent?: string | null;
};

type AppearanceConfigResponse = {
  appearance: AppearanceConfig;
};

export const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  theme: "system",
};

export type TerminalConfig = {
  font_family: string | null;
  font_size: number;
  line_height: number;
};

type TerminalConfigResponse = {
  terminal: TerminalConfig;
};

export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  font_family: null,
  font_size: 13,
  line_height: 1.2,
};

export type NotificationConfig = {
  enabled: boolean;
  on_task_complete: boolean;
  on_input_needed: boolean;
};

type NotificationConfigResponse = {
  notifications: NotificationConfig;
};

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  on_task_complete: true,
  on_input_needed: true,
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

export const fetchMergeSettings = async (): Promise<MergeSettingsResponse> => {
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

export const fetchAppearanceConfig =
  async (): Promise<AppearanceConfigResponse> => {
    return desktopFetch<AppearanceConfigResponse>(
      "/rpc/preferences/appearance",
    );
  };

export const saveAppearanceConfig = async (
  payload: Partial<AppearanceConfig>,
): Promise<AppearanceConfigResponse> => {
  return desktopFetch<AppearanceConfigResponse>("/rpc/preferences/appearance", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
};

export const fetchTerminalConfig =
  async (): Promise<TerminalConfigResponse> => {
    return desktopFetch<TerminalConfigResponse>("/rpc/preferences/terminal");
  };

export const saveTerminalConfig = async (
  payload: Partial<TerminalConfig>,
): Promise<TerminalConfigResponse> => {
  return desktopFetch<TerminalConfigResponse>("/rpc/preferences/terminal", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
};

export const fetchNotificationConfig =
  async (): Promise<NotificationConfigResponse> => {
    return desktopFetch<NotificationConfigResponse>(
      "/rpc/preferences/notifications",
    );
  };

export const saveNotificationConfig = async (
  payload: Partial<NotificationConfig>,
): Promise<NotificationConfigResponse> => {
  return desktopFetch<NotificationConfigResponse>(
    "/rpc/preferences/notifications",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
};
