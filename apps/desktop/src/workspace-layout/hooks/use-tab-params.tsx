import { useParams } from "@tanstack/react-router";
import { type ReactNode, createContext, useContext, useMemo } from "react";
import type { Tab, TabKind } from "../types";

/**
 * When a tab body renders, it receives the TabKind payload (taskId, runId,
 * file path, etc.) via this context rather than reading the URL. Existing
 * views — many of which still call `useParams` directly — should migrate
 * to the resolver hooks below so they work both inside a tab and at the
 * old route position.
 */

interface TabParamsContextValue {
  tab: Tab;
  kind: TabKind;
}

const TabParamsContext = createContext<TabParamsContextValue | null>(null);

interface TabParamsProviderProps {
  tab: Tab;
  children: ReactNode;
}

export function TabParamsProvider({ tab, children }: TabParamsProviderProps) {
  const value = useMemo<TabParamsContextValue>(
    () => ({ tab, kind: tab.kind }),
    [tab],
  );
  return (
    <TabParamsContext.Provider value={value}>
      {children}
    </TabParamsContext.Provider>
  );
}

export function useOptionalTabKind(): TabKind | null {
  return useContext(TabParamsContext)?.kind ?? null;
}

export function useOptionalTab(): Tab | null {
  return useContext(TabParamsContext)?.tab ?? null;
}

export function useResolvedTaskId(): string | null {
  const fromTab = useOptionalTabKind();
  const params = useParams({ strict: false }) as { taskId?: string };
  if (fromTab?.type === "session") return fromTab.taskId ?? null;
  return params.taskId ?? null;
}

export function useResolvedRunId(): string | null {
  const fromTab = useOptionalTabKind();
  const params = useParams({ strict: false }) as { runId?: string };
  if (fromTab?.type === "session") return fromTab.runId ?? null;
  if (fromTab?.type === "diff") return fromTab.runId;
  return params.runId ?? null;
}
