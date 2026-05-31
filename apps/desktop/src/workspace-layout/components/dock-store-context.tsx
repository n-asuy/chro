import { type ReactNode, createContext, useContext, useMemo } from "react";
import { useDockStore } from "../state/dock-store";
import { useRightDockStore } from "../state/right-dock-store";

/**
 * Selects between the left or right dock store inside panel components.
 * Defaults to the left dock so existing call sites (panels rendered by
 * LeftDock without an explicit provider) keep their behaviour.
 */
export type DockSide = "left" | "right";

const DockSideContext = createContext<DockSide>("left");

export function DockSideProvider({
  side,
  children,
}: {
  side: DockSide;
  children: ReactNode;
}) {
  return (
    <DockSideContext.Provider value={side}>{children}</DockSideContext.Provider>
  );
}

export function useDockSide(): DockSide {
  return useContext(DockSideContext);
}

/**
 * Close handler for the dock that's currently hosting this panel. Returns
 * `undefined` on the right side, where chrome lives outside the panel
 * (header toggle + footer icons), so panels skip rendering their own
 * close button.
 */
export function useDockCloseHandler(): (() => void) | undefined {
  const side = useDockSide();
  const leftSetCollapsed = useDockStore((s) => s.setCollapsed);
  return useMemo(() => {
    if (side === "right") return undefined;
    return () => leftSetCollapsed(true);
  }, [side, leftSetCollapsed]);
}

/**
 * Read the host dock's search-focus token. Bumped whenever ⌘K or the
 * search icon route focus at the search panel, even when it was already
 * mounted. Search now lives only in the right dock.
 */
export function useDockSearchFocusToken(): number {
  return useRightDockStore((s) => s.searchFocusToken);
}
