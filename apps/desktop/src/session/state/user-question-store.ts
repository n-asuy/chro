import { create } from "zustand";

export const QUESTIONS_SKIPPED_MESSAGE =
  "User skipped questions - proceed with defaults";
export const QUESTIONS_TIMED_OUT_MESSAGE = "Timed out";

export interface UserQuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

export interface PendingUserQuestions {
  taskRunId: string;
  toolUseId: string;
  questions: UserQuestion[];
}

interface UserQuestionStore {
  // Map<taskRunId, PendingUserQuestions>
  pendingQuestions: Map<string, PendingUserQuestions>;

  // Map<toolUseId, result> for real-time updates before DB sync
  results: Map<string, Record<string, string>>;

  setPendingQuestions: (
    taskRunId: string,
    questions: PendingUserQuestions | null,
  ) => void;
  clearPendingQuestions: (taskRunId: string) => void;
  setResult: (toolUseId: string, result: Record<string, string>) => void;
  clearResult: (toolUseId: string) => void;
}

export const useUserQuestionStore = create<UserQuestionStore>((set) => ({
  pendingQuestions: new Map(),
  results: new Map(),

  setPendingQuestions: (taskRunId, questions) =>
    set((state) => {
      const next = new Map(state.pendingQuestions);
      if (questions) {
        next.set(taskRunId, questions);
      } else {
        next.delete(taskRunId);
      }
      return { pendingQuestions: next };
    }),

  clearPendingQuestions: (taskRunId) =>
    set((state) => {
      if (!state.pendingQuestions.has(taskRunId)) return state;
      const next = new Map(state.pendingQuestions);
      next.delete(taskRunId);
      return { pendingQuestions: next };
    }),

  setResult: (toolUseId, result) =>
    set((state) => {
      const next = new Map(state.results);
      next.set(toolUseId, result);
      return { results: next };
    }),

  clearResult: (toolUseId) =>
    set((state) => {
      if (!state.results.has(toolUseId)) return state;
      const next = new Map(state.results);
      next.delete(toolUseId);
      return { results: next };
    }),
}));
