import { useLanguage } from "@/i18n";
import type { StoredTask } from "@/session/types";
import { taskApi } from "@/tasks/task-api";
import { useState } from "react";
import { TASK_ICON_NAMES, taskIcon } from "../domain/task-icons";
import { EdgeTaskIcon } from "./edge-task-icon";

/**
 * The session icon picker (the mock's picker grid): every icon, the current
 * one outlined; a click stores it on the session, and the capsule follows
 * as the session's record streams back.
 */
export function EdgeIconPicker({ task }: { task: StoredTask }) {
  const { t } = useLanguage();
  // Shown at once; the streamed record confirms it.
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = taskIcon(chosen ?? task.icon);
  const choose = (icon: string) => {
    setChosen(icon);
    setError(null);
    taskApi.setTaskIcon(task.id, icon).catch((cause: unknown) => {
      setChosen(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  return (
    <div className="edge-icon-picker" data-edge-icon-picker>
      <div className="edge-icon-grid">
        {TASK_ICON_NAMES.map((icon) => (
          <button
            key={icon}
            type="button"
            title={icon}
            aria-label={icon}
            aria-pressed={icon === current}
            data-on={icon === current ? "" : undefined}
            onClick={() => choose(icon)}
          >
            <EdgeTaskIcon name={icon} />
          </button>
        ))}
      </div>
      <p className="edge-icon-picker-foot">
        {error ?? t("edgeToolbarSessionIconDescription")}
      </p>
    </div>
  );
}
