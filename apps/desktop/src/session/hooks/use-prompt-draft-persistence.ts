import {
  getUiValue,
  isUiStateReady,
  removeUiValue,
  setUiValue,
} from "@/lib/ui-state-client";
import { useEffect } from "react";
import type { PromptEditorHandle } from "../state/prompt-editor-store";
import {
  getPromptEditorScopeState,
  usePromptEditorStore,
} from "../state/prompt-editor-store";
import type { ContentPart, Prompt } from "../types/context";

const STORAGE_VERSION = 1;
const STORAGE_KEY_PREFIX = "session:prompt-draft";

type StoredPromptDraft = {
  version: number;
  prompt: Prompt;
  updatedAt: number;
};

function storageKey(scopeId: string): string {
  return `${STORAGE_KEY_PREFIX}:v${STORAGE_VERSION}:${scopeId}`;
}

function isContentPart(value: unknown): value is ContentPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Partial<ContentPart>;
  if (
    typeof part.type !== "string" ||
    typeof part.content !== "string" ||
    typeof part.start !== "number" ||
    typeof part.end !== "number"
  ) {
    return false;
  }

  if (part.type === "text") {
    return true;
  }

  if (part.type === "file") {
    return (
      typeof (part as { path?: unknown }).path === "string" &&
      typeof (part as { isFile?: unknown }).isFile === "boolean"
    );
  }

  if (part.type === "session") {
    return typeof (part as { taskId?: unknown }).taskId === "string";
  }

  if (part.type === "skill") {
    return (
      typeof (part as { id?: unknown }).id === "string" &&
      typeof (part as { name?: unknown }).name === "string"
    );
  }

  return false;
}

function isPrompt(value: unknown): value is Prompt {
  return Array.isArray(value) && value.every(isContentPart);
}

function readPromptDraft(scopeId: string): Prompt | null {
  const stored = getUiValue<StoredPromptDraft>(storageKey(scopeId));
  if (!stored || stored.version !== STORAGE_VERSION) return null;
  return isPrompt(stored.prompt) ? stored.prompt : null;
}

function writePromptDraft(scopeId: string, prompt: Prompt): void {
  setUiValue(storageKey(scopeId), {
    version: STORAGE_VERSION,
    prompt,
    updatedAt: Date.now(),
  } satisfies StoredPromptDraft);
}

function removePromptDraft(scopeId: string): void {
  removeUiValue(storageKey(scopeId));
}

export function usePromptDraftPersistence(editor: PromptEditorHandle): void {
  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let hydrated = false;
    let changedBeforeHydration = false;
    let applyingHydration = false;
    let previousPrompt = getPromptEditorScopeState(
      usePromptEditorStore.getState(),
      editor.scopeId,
    ).prompt;

    const persistScope = (scopeId: string): void => {
      const scope = getPromptEditorScopeState(
        usePromptEditorStore.getState(),
        scopeId,
      );
      if (scope.isEmpty) {
        removePromptDraft(scopeId);
      } else {
        writePromptDraft(scopeId, scope.prompt);
      }
    };

    const unsubscribe = usePromptEditorStore.subscribe((state) => {
      const scope = getPromptEditorScopeState(state, editor.scopeId);
      if (scope.prompt === previousPrompt) {
        return;
      }
      previousPrompt = scope.prompt;

      if (applyingHydration) {
        return;
      }

      if (!hydrated) {
        changedBeforeHydration = true;
        return;
      }

      persistScope(editor.scopeId);
    });

    const hydrateAndSubscribe = (): boolean => {
      if (!isUiStateReady()) {
        return false;
      }

      const store = usePromptEditorStore.getState();
      const currentScope = getPromptEditorScopeState(store, editor.scopeId);
      const storedPrompt = readPromptDraft(editor.scopeId);

      if (storedPrompt && currentScope.isEmpty && !changedBeforeHydration) {
        applyingHydration = true;
        try {
          store.setPrompt(editor.scopeId, storedPrompt);
        } finally {
          applyingHydration = false;
        }
        previousPrompt = getPromptEditorScopeState(
          usePromptEditorStore.getState(),
          editor.scopeId,
        ).prompt;
        editor.syncDomFromStore();
      }

      hydrated = true;
      persistScope(editor.scopeId);

      return true;
    };

    if (!hydrateAndSubscribe()) {
      intervalId = setInterval(() => {
        if (cancelled) return;
        if (hydrateAndSubscribe() && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }, 50);
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      unsubscribe?.();
    };
  }, [editor]);
}
