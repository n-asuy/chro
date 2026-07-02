/**
 * Apply (or clear) the derived accent variables on a root element.
 *
 * Writing the variables is a pure function of store state (the seed + resolved
 * mode), so optimistic update, server-echo, and rollback all repaint correctly
 * by simply re-running with the current state. Clearing removes exactly the
 * properties this module manages, falling back to the static globals.css
 * defaults.
 */
import { ACCENT_VAR_NAMES } from "./accent-derivation";

/** Minimal structural shape of an element's inline style; satisfied by HTMLElement. */
interface StyleTarget {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

export function applyAccentVars(
  root: StyleTarget,
  vars: Record<string, string> | null,
): void {
  if (vars === null) {
    for (const name of ACCENT_VAR_NAMES) {
      root.style.removeProperty(name);
    }
    return;
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
