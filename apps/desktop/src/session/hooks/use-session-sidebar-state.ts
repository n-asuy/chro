import { useCallback, useEffect, useState } from "react";
import { getUiValue, setUiValue } from "@/lib/ui-state-client";

type UseSessionSidebarStateArgs = {
  defaultWidth: number;
  storageKey: string;
  externalSidebarCollapsed?: boolean;
  externalToggleSidebar?: () => void;
};

type UseSessionSidebarStateResult = {
  sessionSidebarWidth: number;
  sessionSidebarCollapsed: boolean;
  sessionSidebarPeek: boolean;
  setSessionSidebarWidth: (next: number) => void;
  toggleSessionSidebarCollapsed: (value?: boolean) => void;
  toggleSessionSidebarPeek: (value?: boolean) => void;
};

export function useSessionSidebarState({
  defaultWidth,
  storageKey,
  externalSidebarCollapsed,
  externalToggleSidebar,
}: UseSessionSidebarStateArgs): UseSessionSidebarStateResult {
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(defaultWidth);
  const [internalSidebarCollapsed, setInternalSidebarCollapsed] =
    useState(false);
  const [sessionSidebarPeek, setSessionSidebarPeek] = useState(false);

  const sessionSidebarCollapsed =
    externalSidebarCollapsed ?? internalSidebarCollapsed;

  const toggleSessionSidebarCollapsed = useCallback(
    (value?: boolean) => {
      if (externalToggleSidebar) {
        externalToggleSidebar();
        return;
      }

      setInternalSidebarCollapsed((prev) =>
        typeof value === "boolean" ? value : !prev,
      );
    },
    [externalToggleSidebar],
  );

  const toggleSessionSidebarPeek = useCallback((value?: boolean) => {
    setSessionSidebarPeek((prev) =>
      typeof value === "boolean" ? value : !prev,
    );
  }, []);

  useEffect(() => {
    const stored = getUiValue<number>(storageKey);
    if (stored !== null && !Number.isNaN(stored)) {
      setSessionSidebarWidth(stored);
    }
  }, [storageKey]);

  useEffect(() => {
    setUiValue(storageKey, sessionSidebarWidth);
  }, [storageKey, sessionSidebarWidth]);

  return {
    sessionSidebarWidth,
    sessionSidebarCollapsed,
    sessionSidebarPeek,
    setSessionSidebarWidth,
    toggleSessionSidebarCollapsed,
    toggleSessionSidebarPeek,
  };
}
