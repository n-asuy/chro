import { useLanguage } from "@/i18n";
import { Switch } from "@chro/ui/switch";
import { useEffect } from "react";
import { SettingsRow } from "../components/settings-row";
import { SettingsSection } from "../components/settings-section";
import { useNotificationConfigStore } from "../state/notification-config-store";

export function NotificationsPane() {
  const { t } = useLanguage();
  const config = useNotificationConfigStore((s) => s.config);
  const loaded = useNotificationConfigStore((s) => s.loaded);
  const load = useNotificationConfigStore((s) => s.load);
  const update = useNotificationConfigStore((s) => s.update);

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("notificationsSettingsTitle")}
        </h2>
        <p className="font-workspace text-[13px] text-muted-foreground mt-1">
          {t("notificationsSettingsDescription")}
        </p>
      </div>

      <SettingsSection>
        <SettingsRow
          title={t("notificationsEnabledTitle")}
          description={t("notificationsEnabledDescription")}
          control={
            <Switch
              checked={config.enabled}
              onCheckedChange={(checked) => void update({ enabled: checked })}
            />
          }
        />
        <SettingsRow
          title={t("notificationsOnTaskCompleteTitle")}
          description={t("notificationsOnTaskCompleteDescription")}
          disabled={!config.enabled}
          control={
            <Switch
              checked={config.enabled && config.on_task_complete}
              disabled={!config.enabled}
              onCheckedChange={(checked) =>
                void update({ on_task_complete: checked })
              }
            />
          }
        />
        <SettingsRow
          title={t("notificationsOnInputNeededTitle")}
          description={t("notificationsOnInputNeededDescription")}
          disabled={!config.enabled}
          control={
            <Switch
              checked={config.enabled && config.on_input_needed}
              disabled={!config.enabled}
              onCheckedChange={(checked) =>
                void update({ on_input_needed: checked })
              }
            />
          }
        />
      </SettingsSection>
    </section>
  );
}
