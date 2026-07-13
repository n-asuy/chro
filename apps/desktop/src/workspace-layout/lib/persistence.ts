import { getUiValue, setUiValue } from "@/lib/ui-state-client";
import type { DockState, PaneLayout } from "../types";

/**
 * Layout state is persisted via the local Rust server's ui-state RPC, the
 * same channel used elsewhere for sidebar collapse / dock state. Schema
 * version is encoded in the storage key so a breaking change can coexist
 * with stale entries (older keys are simply ignored).
 */

const LAYOUT_SCHEMA_VERSION = 2;
const DOCK_SCHEMA_VERSION = 1;

interface PersistedLayout {
  version: number;
  layout: PaneLayout;
}

interface PersistedDock {
  version: number;
  dock: DockState;
}

function layoutKey(projectId: string): string {
  return `workspace-layout:layout:v${LAYOUT_SCHEMA_VERSION}:${projectId}`;
}

function dockKey(): string {
  return `workspace-layout:dock:v${DOCK_SCHEMA_VERSION}`;
}

function legacyProjectDockKey(projectId: string): string {
  return `workspace-layout:dock:v${DOCK_SCHEMA_VERSION}:${projectId}`;
}

function rightDockKey(): string {
  return `workspace-layout:right-dock:v${DOCK_SCHEMA_VERSION}`;
}

function legacyProjectRightDockKey(projectId: string): string {
  return `workspace-layout:right-dock:v${DOCK_SCHEMA_VERSION}:${projectId}`;
}

export function loadLayout(projectId: string): PaneLayout | null {
  const persisted = getUiValue<PersistedLayout>(layoutKey(projectId));
  if (!persisted || persisted.version !== LAYOUT_SCHEMA_VERSION) return null;
  return persisted.layout;
}

export function saveLayout(projectId: string, layout: PaneLayout): void {
  const payload: PersistedLayout = { version: LAYOUT_SCHEMA_VERSION, layout };
  setUiValue(layoutKey(projectId), payload);
}

export function loadDock(projectId?: string): DockState | null {
  const persisted = getUiValue<PersistedDock>(dockKey());
  if (persisted && persisted.version === DOCK_SCHEMA_VERSION) {
    return persisted.dock;
  }

  if (!projectId) return null;

  const legacyPersisted = getUiValue<PersistedDock>(
    legacyProjectDockKey(projectId),
  );
  if (!legacyPersisted || legacyPersisted.version !== DOCK_SCHEMA_VERSION) {
    return null;
  }
  return legacyPersisted.dock;
}

export function saveDock(dock: DockState): void {
  const payload: PersistedDock = { version: DOCK_SCHEMA_VERSION, dock };
  setUiValue(dockKey(), payload);
}

export function loadRightDock(projectId?: string): DockState | null {
  const persisted = getUiValue<PersistedDock>(rightDockKey());
  if (persisted && persisted.version === DOCK_SCHEMA_VERSION) {
    return persisted.dock;
  }

  if (!projectId) return null;

  const legacyPersisted = getUiValue<PersistedDock>(
    legacyProjectRightDockKey(projectId),
  );
  if (!legacyPersisted || legacyPersisted.version !== DOCK_SCHEMA_VERSION) {
    return null;
  }
  return legacyPersisted.dock;
}

export function saveRightDock(dock: DockState): void {
  const payload: PersistedDock = { version: DOCK_SCHEMA_VERSION, dock };
  setUiValue(rightDockKey(), payload);
}
