import { useCallback, useEffect, useRef } from "react";
import { writeProjectFile } from "@/lib/project-client";
import { useProjectId } from "../context/project-context";

const DEFAULT_DEBOUNCE_MS = 2000;

type UseAutoSaveOptions = {
  /** File path relative to workspace root */
  relativePath: string | null;
  /** Current content to save */
  content: string;
  /** Whether auto-save is enabled */
  enabled?: boolean;
  /** Debounce delay in milliseconds (default: 2000ms) */
  debounceMs?: number;
  /** Callback when save succeeds */
  onSaveSuccess?: () => void;
  /** Callback when save fails */
  onSaveError?: (error: Error) => void;
};

type UseAutoSaveReturn = {
  /** Trigger immediate save (for blur events) */
  saveNow: () => Promise<void>;
  /** Whether a save is currently in progress */
  isSaving: boolean;
  /** Whether there are unsaved changes */
  isDirty: boolean;
};

/**
 * Obsidian-style auto-save hook.
 *
 * Saves content automatically:
 * 1. After debounce delay (default 2s) when content changes
 * 2. Immediately when saveNow() is called (for blur events)
 */
export function useAutoSave({
  relativePath,
  content,
  enabled = true,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  onSaveSuccess,
  onSaveError,
}: UseAutoSaveOptions): UseAutoSaveReturn {
  const projectId = useProjectId();
  const isSavingRef = useRef(false);
  const isDirtyRef = useRef(false);
  const lastSavedContentRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const relativePathRef = useRef(relativePath);
  const projectIdRef = useRef(projectId);

  // Keep refs in sync
  projectIdRef.current = projectId;

  // Keep refs in sync
  contentRef.current = content;
  relativePathRef.current = relativePath;

  // Track dirty state
  useEffect(() => {
    if (lastSavedContentRef.current === null) {
      // First load - initialize with current content
      lastSavedContentRef.current = content;
      isDirtyRef.current = false;
    } else {
      isDirtyRef.current = content !== lastSavedContentRef.current;
    }
  }, [content]);

  // Reset saved content when file changes
  useEffect(
    () => {
      lastSavedContentRef.current = content;
      isDirtyRef.current = false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally reset only when file changes, not on every content change
    [relativePath],
  );

  const performSave = useCallback(async () => {
    const path = relativePathRef.current;
    const currentContent = contentRef.current;
    const currentProjectId = projectIdRef.current;

    if (!path || !enabled || !currentProjectId) return;
    if (isSavingRef.current) return;
    if (currentContent === lastSavedContentRef.current) return;

    isSavingRef.current = true;

    try {
      await writeProjectFile(currentProjectId, path, currentContent);
      lastSavedContentRef.current = currentContent;
      isDirtyRef.current = false;
      onSaveSuccess?.();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onSaveError?.(error);
    } finally {
      isSavingRef.current = false;
    }
  }, [enabled, onSaveSuccess, onSaveError]);

  // Debounced save on content change
  useEffect(() => {
    if (!enabled || !relativePath) return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (content === lastSavedContentRef.current) return;

    debounceTimerRef.current = setTimeout(() => {
      void performSave();
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [content, enabled, relativePath, debounceMs, performSave]);

  // Save immediately (for blur events)
  const saveNow = useCallback(async () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    await performSave();
  }, [performSave]);

  return {
    saveNow,
    isSaving: isSavingRef.current,
    isDirty: isDirtyRef.current,
  };
}
