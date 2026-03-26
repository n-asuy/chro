import { useCallback, useState } from "react";
import {
  fetchWorktreeInfo,
  cleanupWorktrees,
  type WorktreeInfoResponse,
} from "@/lib/developer-client";
import type { TranslationFunction } from "@/i18n";

type WorktreeCleanupState = "idle" | "cleaning" | "success" | "error";

type WorktreeCleanupResult = {
  deletedCount: number;
  freedBytes: number;
};

type WorktreeSettingsState = {
  worktreeInfo: WorktreeInfoResponse | null;
  worktreeLoading: boolean;
  worktreeError: string | null;
  worktreeCleanupState: WorktreeCleanupState;
  worktreeCleanupResult: WorktreeCleanupResult | null;
  selectedPaths: Set<string>;
  loadWorktreeInfo: () => Promise<void>;
  handleCleanupAllWorktrees: () => Promise<void>;
  handleCleanupSingleWorktree: (path: string) => Promise<void>;
  handleCleanupSelectedWorktrees: () => Promise<void>;
  toggleSelection: (path: string) => void;
  toggleSelectAll: () => void;
  clearSelection: () => void;
  formatBytes: (bytes: number) => string;
};

export function useWorktreeSettings({
  t,
}: {
  t: TranslationFunction;
}): WorktreeSettingsState {
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfoResponse | null>(
    null,
  );
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [worktreeCleanupState, setWorktreeCleanupState] =
    useState<WorktreeCleanupState>("idle");
  const [worktreeCleanupResult, setWorktreeCleanupResult] =
    useState<WorktreeCleanupResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const loadWorktreeInfo = useCallback(async () => {
    setWorktreeLoading(true);
    setWorktreeError(null);
    try {
      const info = await fetchWorktreeInfo();
      setWorktreeInfo(info);
    } catch (error) {
      setWorktreeError(
        error instanceof Error
          ? error.message
          : t("developerWorktreeLoadError"),
      );
    } finally {
      setWorktreeLoading(false);
    }
  }, [t]);

  const handleCleanupAllWorktrees = useCallback(async () => {
    setWorktreeCleanupState("cleaning");
    setWorktreeError(null);
    setWorktreeCleanupResult(null);
    try {
      const result = await cleanupWorktrees();
      setWorktreeCleanupResult({
        deletedCount: result.deleted_count,
        freedBytes: result.freed_bytes,
      });
      setWorktreeCleanupState("success");
      // Reload worktree info after cleanup
      void loadWorktreeInfo();
      setTimeout(() => setWorktreeCleanupState("idle"), 3000);
    } catch (error) {
      setWorktreeCleanupState("error");
      setWorktreeError(
        error instanceof Error
          ? error.message
          : t("developerWorktreeCleanupError"),
      );
    }
  }, [loadWorktreeInfo, t]);

  const handleCleanupSingleWorktree = useCallback(
    async (path: string) => {
      setWorktreeCleanupState("cleaning");
      setWorktreeError(null);
      try {
        const result = await cleanupWorktrees([path]);
        setWorktreeCleanupResult({
          deletedCount: result.deleted_count,
          freedBytes: result.freed_bytes,
        });
        setWorktreeCleanupState("success");
        void loadWorktreeInfo();
        setTimeout(() => setWorktreeCleanupState("idle"), 3000);
      } catch (error) {
        setWorktreeCleanupState("error");
        setWorktreeError(
          error instanceof Error
            ? error.message
            : t("developerWorktreeCleanupError"),
        );
      }
    },
    [loadWorktreeInfo, t],
  );

  const toggleSelection = useCallback((path: string) => {
    setSelectedPaths((prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!worktreeInfo) return;
    setSelectedPaths((prev: Set<string>) => {
      const allPaths = worktreeInfo.entries.map((e: { path: string }) => e.path);
      if (prev.size === allPaths.length) {
        return new Set<string>();
      }
      return new Set(allPaths);
    });
  }, [worktreeInfo]);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set<string>());
  }, []);

  const handleCleanupSelectedWorktrees = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    setWorktreeCleanupState("cleaning");
    setWorktreeError(null);
    setWorktreeCleanupResult(null);
    try {
      const result = await cleanupWorktrees([...selectedPaths]);
      setWorktreeCleanupResult({
        deletedCount: result.deleted_count,
        freedBytes: result.freed_bytes,
      });
      setWorktreeCleanupState("success");
      setSelectedPaths(new Set());
      void loadWorktreeInfo();
      setTimeout(() => setWorktreeCleanupState("idle"), 3000);
    } catch (error) {
      setWorktreeCleanupState("error");
      setWorktreeError(
        error instanceof Error
          ? error.message
          : t("developerWorktreeCleanupError"),
      );
    }
  }, [selectedPaths, loadWorktreeInfo, t]);

  const formatBytes = useCallback((bytes: number): string => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }, []);

  return {
    worktreeInfo,
    worktreeLoading,
    worktreeError,
    worktreeCleanupState,
    worktreeCleanupResult,
    selectedPaths,
    loadWorktreeInfo,
    handleCleanupAllWorktrees,
    handleCleanupSingleWorktree,
    handleCleanupSelectedWorktrees,
    toggleSelection,
    toggleSelectAll,
    clearSelection,
    formatBytes,
  };
}
