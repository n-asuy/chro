import { cn } from "@/lib/cn";
import { useDroppable } from "@dnd-kit/core";
import { memo, useMemo } from "react";
import { TabParamsProvider } from "../hooks/use-tab-params";
import { getPaneItem } from "../registry/registry";
import { useLayoutStore } from "../state/layout-store";
import type { PaneLeaf, Tab } from "../types";
import { EmptyPaneState } from "./empty-pane-state";
import { usePaneDropPreview } from "./pane-dnd-context";
import { SplitDropOverlay } from "./split-drop-overlay";
import { TabBar } from "./tab-bar";

interface PaneContainerProps {
  leaf: PaneLeaf;
  isFocused: boolean;
}

export const PaneContainer = memo(function PaneContainer({
  leaf,
  isFocused,
}: PaneContainerProps) {
  const setFocusedPane = useLayoutStore((s) => s.setFocusedPane);
  const droppable = useDroppable({
    id: `pane-body:${leaf.id}`,
    data: { kind: "pane-body", leafId: leaf.id },
  });
  const previewEdge = usePaneDropPreview(leaf.id);

  const activeTab = useMemo(
    () =>
      leaf.tabs.find((t) => t.id === leaf.activeTabId) ??
      leaf.tabs[leaf.tabs.length - 1] ??
      null,
    [leaf.tabs, leaf.activeTabId],
  );

  return (
    <div
      data-pane-leaf-id={leaf.id}
      className={cn(
        "relative flex h-full w-full min-h-0 min-w-0 flex-col bg-background",
      )}
      onMouseDown={() => {
        if (!isFocused) setFocusedPane(leaf.id);
      }}
    >
      <TabBar leaf={leaf} isFocused={isFocused} />
      <div
        ref={droppable.setNodeRef}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        {activeTab ? (
          <PaneItemBody
            key={activeTab.id}
            tab={activeTab}
            isActiveLeaf={isFocused}
          />
        ) : (
          <EmptyPaneState leafId={leaf.id} />
        )}
        {previewEdge ? (
          <SplitDropOverlay
            leafId={leaf.id}
            container={droppable.over?.rect ?? null}
            edge={previewEdge}
          />
        ) : null}
      </div>
    </div>
  );
});

function PaneItemBody({
  tab,
  isActiveLeaf,
}: {
  tab: Tab;
  isActiveLeaf: boolean;
}) {
  const desc = getPaneItem(tab.kind.type);
  if (!desc) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Unknown tab kind: {tab.kind.type}
      </div>
    );
  }
  const Content = desc.Content;
  return (
    <TabParamsProvider tab={tab}>
      <div className="h-full w-full" data-tab-id={tab.id}>
        <Content
          tab={tab}
          kind={tab.kind as never}
          isActiveLeaf={isActiveLeaf}
        />
      </div>
    </TabParamsProvider>
  );
}
