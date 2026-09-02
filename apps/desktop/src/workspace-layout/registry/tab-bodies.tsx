import { FilesEditor } from "@/files/components/editor/files-editor";
import { useFileTreeStore } from "@/files/state/file-tree-store";
import { useFilesStore } from "@/files/state/files-store";
import { useWorkingDiffs } from "@/files/state/working-diffs-store";
import { GalleryPanel } from "@/gallery/gallery-panel";
import { DiffViewerPanel } from "@/session/components/diff-viewer-panel";
import { useDiffStream } from "@/session/hooks/use-diff-stream";
import { SingleAgentSessionView } from "@/session/single-agent-session";
import { SettingsPanel } from "@/settings/settings-panel";
import { SkillsPanel } from "@/skills/skills-panel";
import { useEffect, useMemo } from "react";
import { BrowserPane } from "../components/browser-pane";
import { NativeBrowserPane } from "../components/native-browser-pane";
import { useLayoutStore } from "../state/layout-store";
import type { PaneItemRenderProps } from "./registry";

/**
 * Per-kind tab body adapters. Each receives the resolved kind payload and
 * renders the existing inner view, omitting any shell chrome
 * (e.g. the header / dock) — those are owned by the outer LayoutShell.
 *
 * Most kinds reuse the existing component verbatim; the kind payload feeds
 * through the TabKindContext provided by PaneContainer.
 */

export function OverviewTabBody(_: PaneItemRenderProps) {
  // Home is the start-a-session surface: the same composer a brand-new session
  // shows, so a prompt can be typed immediately. Its empty body renders the
  // project launcher (recent sessions) instead of a logo/tagline hero.
  return <SingleAgentSessionView forceNewSession />;
}

export function SessionTabBody(_: PaneItemRenderProps) {
  return <SingleAgentSessionView />;
}

export function FileTabBody({ isActiveLeaf, kind, tab }: PaneItemRenderProps) {
  if (kind.type !== "file") return null;
  return (
    <SingleFileEditor
      path={kind.path}
      taskRunId={kind.taskRunId}
      isActiveLeaf={isActiveLeaf}
      tabId={tab.id}
    />
  );
}

function SingleFileEditor({
  isActiveLeaf,
  path,
  taskRunId,
  tabId,
}: {
  isActiveLeaf: boolean;
  path: string;
  taskRunId?: string;
  tabId: string;
}) {
  const expandToPath = useFileTreeStore((s) => s.expandToPath);
  const closeTab = useLayoutStore((s) => s.closeTab);

  useEffect(() => {
    if (!isActiveLeaf) return;
    if (useFilesStore.getState().currentFilePath !== path) {
      useFilesStore.setState({ currentFilePath: path });
    }
    // Skip project-tree reflection for task-run-scoped tabs: the file may not
    // exist in the project tree at all.
    if (taskRunId) return;
    // The active editor and the File Explorer selection are separate states.
    // In particular, Cmd/Ctrl-click opens a file without collapsing an
    // existing Alt/Option multi-selection.
    expandToPath(path);
  }, [expandToPath, isActiveLeaf, path, taskRunId]);

  return (
    <div className="h-full w-full">
      <FilesEditor
        path={path}
        taskRunId={taskRunId}
        onHtmlFullscreenEscape={() => closeTab(tabId)}
      />
    </div>
  );
}

export function SettingsTabBody() {
  return (
    <div className="h-full overflow-y-auto">
      <SettingsPanel />
    </div>
  );
}

export function SkillsTabBody() {
  return <SkillsPanel />;
}

export function GalleryTabBody({ kind }: PaneItemRenderProps) {
  if (kind.type !== "gallery") return null;
  return <GalleryPanel taskRunId={kind.taskRunId} />;
}

export function InBrowserTabBody({ tab, kind }: PaneItemRenderProps) {
  const url = kind.type === "browser" ? kind.url : undefined;
  return <NativeBrowserPane tabId={tab.id} initialUrl={url} />;
}

export function CdpBrowserTabBody({ tab, kind }: PaneItemRenderProps) {
  const url = kind.type === "cdp-browser" ? kind.url : undefined;
  return <BrowserPane tabId={tab.id} initialUrl={url} />;
}

export function DiffTabBody({ tab, kind }: PaneItemRenderProps) {
  if (kind.type !== "diff") return null;
  return <DiffTabContent runId={kind.runId} tabId={tab.id} />;
}

function DiffTabContent({
  runId,
  tabId,
}: {
  runId: string;
  tabId: string;
}) {
  const closeTab = useLayoutStore((s) => s.closeTab);
  const { diffs } = useDiffStream({ taskRunId: runId });

  const diffEntries = useMemo(
    () => Object.entries(diffs).map(([path, diff]) => ({ path, diff })),
    [diffs],
  );

  return (
    <div className="h-full w-full">
      <DiffViewerPanel
        onClose={() => closeTab(tabId)}
        diffs={diffEntries}
        taskRunId={runId}
      />
    </div>
  );
}

export function ProjectDiffTabBody({ tab, kind }: PaneItemRenderProps) {
  if (kind.type !== "project-diff") return null;
  return <ProjectDiffTabContent projectId={kind.projectId} tabId={tab.id} />;
}

function ProjectDiffTabContent({
  projectId,
  tabId,
}: {
  projectId: string;
  tabId: string;
}) {
  const closeTab = useLayoutStore((s) => s.closeTab);
  const { diffs } = useWorkingDiffs({ projectId });

  return (
    <div className="h-full w-full">
      <DiffViewerPanel onClose={() => closeTab(tabId)} diffs={diffs} />
    </div>
  );
}
