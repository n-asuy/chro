import { createContext, useContext, useEffect } from "react";

/**
 * How a panel's content tells the panel frame it has laid out the data it
 * shows, so the frame can start its open transition with content in the
 * first visible frame (see `panelOnScreen`).
 */
export const PanelReadyContext = createContext<() => void>(() => {});

/** Report readiness once `ready` holds (after the commit that rendered it). */
export function usePanelReady(ready: boolean): void {
  const markReady = useContext(PanelReadyContext);
  useEffect(() => {
    if (ready) markReady();
  }, [ready, markReady]);
}
