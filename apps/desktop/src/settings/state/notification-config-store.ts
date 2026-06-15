import { create } from "zustand";
import {
  type NotificationConfig,
  DEFAULT_NOTIFICATION_CONFIG,
  fetchNotificationConfig,
  saveNotificationConfig,
} from "@/lib/preferences-client";

interface NotificationConfigState {
  config: NotificationConfig;
  loaded: boolean;
  loading: boolean;
}

interface NotificationConfigActions {
  load: () => Promise<void>;
  update: (partial: Partial<NotificationConfig>) => Promise<void>;
}

type NotificationConfigStore = NotificationConfigState &
  NotificationConfigActions;

export const useNotificationConfigStore = create<NotificationConfigStore>(
  (set, get) => ({
    config: DEFAULT_NOTIFICATION_CONFIG,
    loaded: false,
    loading: false,

    load: async () => {
      if (get().loaded || get().loading) return;
      set({ loading: true });
      try {
        const response = await fetchNotificationConfig();
        set({ config: response.notifications, loaded: true });
      } catch (error) {
        console.error("[notification-config] Failed to load", error);
      } finally {
        set({ loading: false });
      }
    },

    update: async (partial) => {
      const prev = get().config;
      set({ config: { ...prev, ...partial } });
      try {
        const response = await saveNotificationConfig(partial);
        set({ config: response.notifications });
      } catch (error) {
        console.error("[notification-config] Failed to save", error);
        set({ config: prev });
      }
    },
  }),
);
