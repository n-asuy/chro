import { useProjectContext } from "@/files/context/project-context";
import { useFilesStore } from "@/files/state/files-store";
import { ProjectTasksProvider } from "@/session/context/project-tasks-context";
import { useSessionReadSync } from "@/session/hooks";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCloseTabShortcut } from "../hooks/use-close-tab-shortcut";
import { useLeaderKeyShortcuts } from "../hooks/use-leader-key-shortcuts";
import { useOpenProjectsSync } from "../hooks/use-open-projects-sync";
import {
  inferKindFromLocation,
  useRouteTabSync,
} from "../hooks/use-route-tab-sync";
import { useSearchShortcut } from "../hooks/use-search-shortcut";
import { useSessionTabArchiveSync } from "../hooks/use-session-tab-archive-sync";
import { useSessionTabTitleSync } from "../hooks/use-session-tab-title-sync";
import { ensurePaneItemsRegistered } from "../registry";
import { useDockStore } from "../state/dock-store";
import { useLayoutStore } from "../state/layout-store";
import { useRightDockStore } from "../state/right-dock-store";
import { FileTreeDockPanel } from "./dock-panels/file-tree-panel";
import { ProjectsDockPanel } from "./dock-panels/projects-panel";
import { SearchDockPanel } from "./dock-panels/search-panel";
import { SourceControlDockPanel } from "./dock-panels/source-control-panel";
import { LeftDock } from "./left-dock";
import { PaneDndContext } from "./pane-dnd-context";
import { PaneTreeView } from "./pane-tree-view";
import { ProjectTabsHeader } from "./project-tabs-header";
import { RightDock } from "./right-dock";

/**
 * Top-level shell: ElectronTitlebar + LeftDock + Center pane tree. Mounts
 * dnd context so tab drag-drop works across all panes. Reads the active
 * project from `ProjectProvider` (must be mounted higher in the tree).
 */
export function LayoutShell() {
  return (
    <ProjectTasksProvider>
      <LayoutShellInner />
    </ProjectTasksProvider>
  );
}

function LayoutShellInner() {
  const { projectId } = useProjectContext();
  const bindLayout = useLayoutStore((s) => s.bindProject);
  const bindDock = useDockStore((s) => s.bindProject);
  const bindRightDock = useRightDockStore((s) => s.bindProject);
  const openTab = useLayoutStore((s) => s.openTab);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    ensurePaneItemsRegistered();
  }, []);

  useEffect(() => {
    if (!projectId) return;
    bindLayout(projectId, { initialTab: inferKindFromLocation(pathname) });
    bindDock(projectId);
    bindRightDock(projectId);
  }, [projectId, pathname, bindLayout, bindDock, bindRightDock]);

  // Bridge files-store.openFile → layout-store.openTab so file path clicks
  // (file tree, session view, agent output, etc.) open as a Tab in the
  // focused pane, regardless of which dock panel is active.
  useEffect(() => {
    const handler = (path: string | null, taskRunId?: string) => {
      if (!path) return;
      openTab(
        taskRunId ? { type: "file", path, taskRunId } : { type: "file", path },
        { activate: true },
      );
    };
    useFilesStore.setState({ _onFilePathChange: handler });
    return () => {
      useFilesStore.setState({ _onFilePathChange: null });
    };
  }, [openTab]);

  useOpenProjectsSync();
  useSessionReadSync();
  useRouteTabSync();
  useLeaderKeyShortcuts();
  useSearchShortcut();
  useCloseTabShortcut();
  useSessionTabTitleSync();
  useSessionTabArchiveSync();

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-muted/40 text-foreground">
      <ProjectTabsHeader />
      <PaneDndContext>
        <div className="flex min-h-0 flex-1 gap-1.5 px-1.5 pt-1.5 pb-1.5">
          <LeftDock panel={ProjectsDockPanel} />
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-background">
            <PaneTreeView />
          </div>
          <RightDock
            filetree={FileTreeDockPanel}
            search={SearchDockPanel}
            sourceControl={SourceControlDockPanel}
          />
        </div>
      </PaneDndContext>
    </div>
  );
}
