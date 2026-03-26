
import { useCallback, useEffect, useState } from "react";
import { ResizableSidebar } from "@/sidebar/resizable-sidebar";
import { getUiValue, setUiValue } from "@/lib/ui-state-client";
import { SourceControlPanel } from "./source-control/source-control-panel";
import { useProjectContext } from "../context/project-context";

const FILES_RIGHT_PANEL_STORAGE_KEY = "files-right-panel-width";
const FILES_RIGHT_PANEL_DEFAULT_WIDTH = 320;

interface FilesRightPanelProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

export const FilesRightPanel = ({
  collapsed: controlledCollapsed,
  onToggle,
}: FilesRightPanelProps) => {
  const { projectId } = useProjectContext();
  const [width, setWidth] = useState(FILES_RIGHT_PANEL_DEFAULT_WIDTH);
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [peek, setPeek] = useState(false);

  const collapsed = controlledCollapsed ?? internalCollapsed;

  useEffect(() => {
    const stored = getUiValue<number>(FILES_RIGHT_PANEL_STORAGE_KEY);
    if (stored !== null && !Number.isNaN(stored) && stored > 0) {
      setWidth(stored);
    }
  }, []);

  useEffect(() => {
    setUiValue(FILES_RIGHT_PANEL_STORAGE_KEY, width);
  }, [width]);

  const handleToggleCollapsed = useCallback(
    (value?: boolean) => {
      if (onToggle) {
        onToggle();
      } else {
        setInternalCollapsed((prev) => value ?? !prev);
      }
    },
    [onToggle],
  );

  const handleTogglePeek = useCallback((value?: boolean) => {
    setPeek((prev) => value ?? !prev);
  }, []);

  if (!projectId) {
    return null;
  }

  return (
    <ResizableSidebar
      side="right"
      width={width}
      setWidth={setWidth}
      defaultWidth={FILES_RIGHT_PANEL_DEFAULT_WIDTH}
      minWidth={280}
      maxWidth={500}
      isCollapsed={collapsed}
      toggleCollapsed={handleToggleCollapsed}
      showPeek={peek}
      togglePeek={handleTogglePeek}
      disablePeekTrigger={true}
      sidebarClassName="bg-custom-sidebar-background-90"
    >
      <div className="flex h-full flex-col overflow-hidden">
        <SourceControlPanel onClose={() => handleToggleCollapsed(true)} />
      </div>
    </ResizableSidebar>
  );
};
