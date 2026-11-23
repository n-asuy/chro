import { type TranslationFunction, useLanguage } from "@/i18n";
import { type SessionDeletePlan, taskApi } from "@/tasks/task-api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@chro/ui/alert-dialog";
import { useLayoutStore } from "@/workspace-layout/state/layout-store";
import { toast } from "@chro/ui/hooks/use-toast";
import { ToastAction } from "@chro/ui/toast";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { archiveTask } from "../hooks/use-archived-sessions";
import type { StoredTask } from "../types";

/**
 * Archive and delete for the session list, with their confirmations.
 *
 * Archive hides a session and keeps everything, so an idle one archives at
 * once and the toast offers undo; only a running one asks first, because
 * archiving stops it. Delete removes the conversation and the worktrees only
 * that session uses, keeps the branch, and always asks, saying what goes.
 * Once confirmed the session leaves the list at once and the delete runs on;
 * a toast reports when it is done, or brings the session back if it failed.
 */

/** A session to delete. Its tabs name it by id or by slug. */
export interface RemovableSession {
  id: string;
  slug?: string | null;
  title: string | null;
}

export interface SessionRemoval {
  archive: (task: StoredTask) => void;
  remove: (session: RemovableSession) => void;
  /** Whether a confirmed delete of this session id is under way or done. */
  isDeleting: (sessionId: string) => boolean;
}

const SessionRemovalContext = createContext<SessionRemoval | null>(null);

export function useSessionRemoval(): SessionRemoval {
  const value = useContext(SessionRemovalContext);
  if (!value) {
    throw new Error(
      "useSessionRemoval must be used within SessionRemovalProvider",
    );
  }
  return value;
}

/** The delete confirmation's description, from what the delete removes. */
export function describeSessionDelete(
  plan: SessionDeletePlan,
  t: TranslationFunction,
): string {
  const parts = [
    plan.worktrees.length > 0
      ? t("deleteSessionRemovesWorktree")
      : t("deleteSessionRemoves"),
  ];
  if (plan.worktrees.length > 0) {
    if (plan.uncommitted_files === null) {
      parts.push(t("deleteSessionUncommittedUnknown"));
    } else if (plan.uncommitted_files > 0) {
      parts.push(
        t("deleteSessionUncommitted", { count: plan.uncommitted_files }),
      );
    }
  }
  if (plan.branch) parts.push(t("deleteSessionKeepsBranch"));
  parts.push(t("cannotBeUndone"));
  return parts.join("");
}

type Pending =
  | { kind: "stop"; task: StoredTask }
  | { kind: "delete"; session: RemovableSession };

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function SessionRemovalProvider({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const [pending, setPending] = useState<Pending | null>(null);
  // Ids leave this set only when their delete fails: on success the stream
  // drops the session, and keeping the id hides it until that patch lands.
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());

  const deleteInBackground = useCallback(
    async (session: RemovableSession) => {
      setDeleting((ids) => new Set(ids).add(session.id));
      useLayoutStore
        .getState()
        .closeSessionTabs(
          [session.id, session.slug].filter((key): key is string => !!key),
        );
      const title = session.title || t("sessionUnresolved");
      try {
        await taskApi.remove(session.id);
      } catch (error) {
        setDeleting((ids) => {
          const next = new Set(ids);
          next.delete(session.id);
          return next;
        });
        toast({
          variant: "destructive",
          title: t("deleteSessionFailed", { title }),
          description: errorMessage(error),
        });
        return;
      }
      toast({ title: t("sessionDeleted", { title }) });
    },
    [t],
  );

  const archiveNow = useCallback(
    async (task: StoredTask) => {
      try {
        await archiveTask(task, taskApi);
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("archiveFailed"),
          description: errorMessage(error),
        });
        return;
      }
      const previous = task.status;
      toast({
        title: t("sessionArchived"),
        duration: 8000,
        action: (
          <ToastAction
            altText={t("undo")}
            onClick={() => {
              void taskApi.updateStatus(task.id, previous);
            }}
          >
            {t("undo")}
          </ToastAction>
        ),
      });
    },
    [t],
  );

  const value = useMemo<SessionRemoval>(
    () => ({
      archive: (task) => {
        if (task.active_session_id) setPending({ kind: "stop", task });
        else void archiveNow(task);
      },
      remove: (session) => setPending({ kind: "delete", session }),
      isDeleting: (sessionId) => deleting.has(sessionId),
    }),
    [archiveNow, deleting],
  );

  const close = () => setPending(null);

  return (
    <SessionRemovalContext.Provider value={value}>
      {children}
      <StopAndArchiveDialog
        task={pending?.kind === "stop" ? pending.task : null}
        onClose={close}
        onConfirm={(task) => {
          close();
          void archiveNow(task);
        }}
        t={t}
      />
      <DeleteSessionDialog
        session={pending?.kind === "delete" ? pending.session : null}
        onClose={close}
        onConfirm={(session) => {
          close();
          void deleteInBackground(session);
        }}
        t={t}
      />
    </SessionRemovalContext.Provider>
  );
}

const CONTENT_CLASS =
  "max-w-md border border-custom-border-200 bg-custom-background-100";
const CANCEL_CLASS =
  "border-custom-border-200 bg-custom-background-90 text-custom-text-200 hover:bg-custom-background-80 hover:text-custom-text-100";

function StopAndArchiveDialog({
  task,
  onClose,
  onConfirm,
  t,
}: {
  task: StoredTask | null;
  onClose: () => void;
  onConfirm: (task: StoredTask) => void;
  t: TranslationFunction;
}) {
  return (
    <AlertDialog
      open={task !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent className={CONTENT_CLASS}>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-custom-text-100">
            {t("archiveRunningTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-custom-text-300">
            {t("archiveRunningDescription", {
              title: task?.title || t("sessionUnresolved"),
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className={CANCEL_CLASS}>
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => task && onConfirm(task)}>
            {t("stopAndArchive")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type PlanState =
  | { status: "loading" }
  | { status: "ready"; plan: SessionDeletePlan }
  | { status: "error"; message: string };

function DeleteSessionDialog({
  session,
  onClose,
  onConfirm,
  t,
}: {
  session: RemovableSession | null;
  onClose: () => void;
  onConfirm: (session: RemovableSession) => void;
  t: TranslationFunction;
}) {
  const [plan, setPlan] = useState<PlanState>({ status: "loading" });
  const sessionId = session?.id ?? null;

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setPlan({ status: "loading" });
    taskApi.deletePlan(sessionId).then(
      (next) => !cancelled && setPlan({ status: "ready", plan: next }),
      (error) =>
        !cancelled &&
        setPlan({ status: "error", message: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <AlertDialog
      open={session !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent className={CONTENT_CLASS}>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-custom-text-100">
            {t("deleteSessionTitle", {
              title: session?.title || t("sessionUnresolved"),
            })}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-custom-text-300">
            {plan.status === "ready"
              ? describeSessionDelete(plan.plan, t)
              : plan.status === "error"
                ? plan.message
                : " "}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className={CANCEL_CLASS}>
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={plan.status !== "ready"}
            onClick={() => session && onConfirm(session)}
            className="bg-red-500 text-white hover:bg-red-600"
          >
            {t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
