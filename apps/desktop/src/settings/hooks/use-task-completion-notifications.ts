import { useLanguage } from "@/i18n";
import { useInboxTasksStream } from "@/session/hooks/use-inbox-tasks-stream";
import { useAllProjects } from "@/workspace-layout/hooks/use-all-projects";
import { useEffect, useRef } from "react";
import {
  type SessionNotificationTarget,
  resolveSessionTarget,
} from "../lib/notification-target";
import { useNotificationConfigStore } from "../state/notification-config-store";

/** Task statuses that mean an agent run has finished. */
const FINISHED_STATUSES = new Set(["completed", "failed"]);

/** The slice of a task we diff across stream updates to detect transitions. */
interface TaskSignal {
  status: string;
  awaitingInput: boolean;
}

interface PendingNotification {
  title: string;
  body: string;
  target: SessionNotificationTarget;
}

/**
 * Watches every task across all projects and fires desktop notifications for
 * two background transitions:
 *
 * - a run finishing (completed/failed), and
 * - a run blocking on an AskUserQuestion and needing the user to answer.
 *
 * Mounted once, inside the language provider. The cross-project inbox stream is
 * only opened while at least one of these notifications is enabled, so there is
 * no extra WebSocket when the feature is off.
 *
 * Notifications are suppressed while the app window is focused: if you are
 * looking at chro you already see the result, so only background transitions
 * surface as OS notifications.
 */
export function useTaskCompletionNotifications(): void {
  const { t } = useLanguage();
  const enabledRoot = useNotificationConfigStore((s) => s.config.enabled);
  const onTaskComplete = useNotificationConfigStore(
    (s) => s.config.on_task_complete,
  );
  const onInputNeeded = useNotificationConfigStore(
    (s) => s.config.on_input_needed,
  );
  const load = useNotificationConfigStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  const completeEnabled = enabledRoot && onTaskComplete;
  const inputEnabled = enabledRoot && onInputNeeded;
  const streamEnabled = completeEnabled || inputEnabled;

  const { tasks } = useInboxTasksStream(streamEnabled);
  const projectsById = useAllProjects(streamEnabled);
  const signalById = useRef<Map<string, TaskSignal>>(new Map());
  const baselineCaptured = useRef(false);

  useEffect(() => {
    if (!streamEnabled) {
      // Reset so re-enabling does not replay already-finished/-waiting tasks.
      signalById.current = new Map();
      baselineCaptured.current = false;
      return;
    }

    const previous = signalById.current;
    const nextSignals = new Map<string, TaskSignal>();
    const completedNow: PendingNotification[] = [];
    const inputNeededNow: PendingNotification[] = [];

    for (const task of tasks) {
      const awaitingInput = Boolean(task.awaiting_input);
      nextSignals.set(task.id, { status: task.status, awaitingInput });
      const before = previous.get(task.id);

      if (baselineCaptured.current && before !== undefined) {
        const transitionedToFinished =
          before.status !== task.status &&
          FINISHED_STATUSES.has(task.status) &&
          !FINISHED_STATUSES.has(before.status);
        if (completeEnabled && transitionedToFinished) {
          completedNow.push({
            title:
              task.status === "failed"
                ? t("notificationTaskFailedTitle")
                : t("notificationTaskCompleteTitle"),
            body: task.title,
            target: resolveSessionTarget(task, projectsById),
          });
        }

        const transitionedToWaiting = !before.awaitingInput && awaitingInput;
        if (inputEnabled && transitionedToWaiting) {
          inputNeededNow.push({
            title: t("notificationInputNeededTitle"),
            body: task.title,
            target: resolveSessionTarget(task, projectsById),
          });
        }
      }
    }

    signalById.current = nextSignals;

    // The first snapshot is the baseline; never notify for tasks that were
    // already finished or waiting when the stream connected.
    if (!baselineCaptured.current) {
      baselineCaptured.current = true;
      return;
    }

    const pending = [...completedNow, ...inputNeededNow];
    if (pending.length === 0) return;
    if (typeof document !== "undefined" && document.hasFocus()) return;

    const notify = window.desktop?.showNotification;
    if (!notify) return;

    for (const item of pending) {
      void notify({
        title: item.title,
        body: item.body,
        target: item.target,
      });
    }
  }, [tasks, streamEnabled, completeEnabled, inputEnabled, projectsById, t]);
}
