import type { ComponentType } from "react";
import type { Tab, TabKind, TabKindType } from "../types";

/**
 * Registry entry for a tab kind. Mirrors Zed's `Item` trait: the renderer
 * receives the full tab and decides what to render based on the kind payload.
 *
 * `resolveTitle` lets a kind compute its tab label dynamically (e.g. "main.ts"
 * vs the persisted generic title). Returning undefined keeps the stored title.
 */
export interface PaneItemDescriptor<K extends TabKind = TabKind> {
  type: K["type"];
  /** Lucide icon name used by TabBar */
  iconName?: string;
  /** Render the tab body within a pane */
  Content: ComponentType<PaneItemRenderProps<K>>;
  /** Optional custom title resolver */
  resolveTitle?: (kind: K) => string | undefined;
}

export interface PaneItemRenderProps<K extends TabKind = TabKind> {
  tab: Tab;
  kind: K;
  /** True when the tab's leaf is the focused pane */
  isActiveLeaf: boolean;
}

const registry = new Map<TabKindType, PaneItemDescriptor>();

export function registerPaneItem<K extends TabKind>(
  descriptor: PaneItemDescriptor<K>,
): void {
  registry.set(descriptor.type, descriptor as unknown as PaneItemDescriptor);
}

export function getPaneItem(
  type: TabKindType,
): PaneItemDescriptor | undefined {
  return registry.get(type);
}

export function listPaneItems(): PaneItemDescriptor[] {
  return Array.from(registry.values());
}
