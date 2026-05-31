import { useEffect, useMemo } from "react";
import { create } from "zustand";
import {
  type PendingSessionSubmission,
  createPendingSessionSubmission,
  finishPendingSessionSubmission,
  isPendingSubmissionSettledByTask,
  resolvePendingSessionSubmission,
} from "../domain/session-task-state";
import type { StoredTask } from "../types";
import type { StartClaudeResponse } from "../types/api";

const UNRESOLVED_PROJECT_KEY = "__unresolved_project__";
const EMPTY_PENDING_SUBMISSIONS: Record<string, PendingSessionSubmission> = {};

export type BeginPendingSessionSubmissionInput = {
  requestId: string;
  prompt: string;
  createdAt: string;
  taskId: string | null;
  taskSlug: string | null;
};

type ScopedBeginPendingSessionSubmissionInput =
  BeginPendingSessionSubmissionInput & {
    scopeId: string;
  };

type PendingSessionSubmissionsByProjectId = Record<
  string,
  Record<string, PendingSessionSubmission>
>;

interface PendingSessionSubmissionsStore {
  submissionsByProjectId: PendingSessionSubmissionsByProjectId;
  beginPendingSubmission: (
    projectId: string | null,
    input: ScopedBeginPendingSessionSubmissionInput,
  ) => PendingSessionSubmission;
  resolvePendingSubmission: (
    projectId: string | null,
    requestId: string,
    response: StartClaudeResponse,
  ) => void;
  finishPendingSubmission: (
    projectId: string | null,
    requestId: string,
    finishedAt: string,
  ) => void;
  clearPendingSubmission: (
    projectId: string | null,
    requestId?: string,
  ) => void;
}

const projectKey = (projectId: string | null): string =>
  projectId ?? UNRESOLVED_PROJECT_KEY;

export const usePendingSessionSubmissionsStore =
  create<PendingSessionSubmissionsStore>()((set) => ({
    submissionsByProjectId: {},
    beginPendingSubmission: (projectId, input) => {
      const next = createPendingSessionSubmission(input);
      const key = projectKey(projectId);

      set((state) => ({
        submissionsByProjectId: {
          ...state.submissionsByProjectId,
          [key]: {
            ...(state.submissionsByProjectId[key] ?? {}),
            [next.requestId]: next,
          },
        },
      }));

      return next;
    },
    resolvePendingSubmission: (projectId, requestId, response) => {
      const key = projectKey(projectId);

      set((state) => {
        const pending = state.submissionsByProjectId[key]?.[requestId];
        if (!pending) {
          return state;
        }

        return {
          submissionsByProjectId: {
            ...state.submissionsByProjectId,
            [key]: {
              ...state.submissionsByProjectId[key],
              [requestId]: resolvePendingSessionSubmission(pending, response),
            },
          },
        };
      });
    },
    finishPendingSubmission: (projectId, requestId, finishedAt) => {
      const key = projectKey(projectId);

      set((state) => {
        const pending = state.submissionsByProjectId[key]?.[requestId];
        if (!pending) {
          return state;
        }

        return {
          submissionsByProjectId: {
            ...state.submissionsByProjectId,
            [key]: {
              ...state.submissionsByProjectId[key],
              [requestId]: finishPendingSessionSubmission(pending, finishedAt),
            },
          },
        };
      });
    },
    clearPendingSubmission: (projectId, requestId) => {
      const key = projectKey(projectId);

      set((state) => {
        const projectSubmissions = state.submissionsByProjectId[key];
        if (!projectSubmissions) {
          return state;
        }

        const nextByProjectId = { ...state.submissionsByProjectId };
        if (!requestId) {
          delete nextByProjectId[key];
          return { submissionsByProjectId: nextByProjectId };
        }

        if (!projectSubmissions[requestId]) {
          return state;
        }

        const nextProjectSubmissions = { ...projectSubmissions };
        delete nextProjectSubmissions[requestId];

        if (Object.keys(nextProjectSubmissions).length === 0) {
          delete nextByProjectId[key];
        } else {
          nextByProjectId[key] = nextProjectSubmissions;
        }

        return { submissionsByProjectId: nextByProjectId };
      });
    },
  }));

export function usePendingSessionSubmissions(
  projectId: string | null,
  streamedTasksById?: Record<string, StoredTask>,
): PendingSessionSubmission[] {
  const key = projectKey(projectId);
  const pendingByRequestId = usePendingSessionSubmissionsStore(
    (state) => state.submissionsByProjectId[key] ?? EMPTY_PENDING_SUBMISSIONS,
  );
  const clearPendingSubmission = usePendingSessionSubmissionsStore(
    (state) => state.clearPendingSubmission,
  );

  const pendingSubmissions = useMemo(
    () =>
      Object.values(pendingByRequestId).sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [pendingByRequestId],
  );

  useEffect(() => {
    if (!streamedTasksById) {
      return;
    }

    for (const pending of pendingSubmissions) {
      if (
        isPendingSubmissionSettledByTask(
          pending,
          pending.taskId ? streamedTasksById[pending.taskId] : null,
        )
      ) {
        clearPendingSubmission(projectId, pending.requestId);
      }
    }
  }, [
    clearPendingSubmission,
    pendingSubmissions,
    projectId,
    streamedTasksById,
  ]);

  return pendingSubmissions;
}
