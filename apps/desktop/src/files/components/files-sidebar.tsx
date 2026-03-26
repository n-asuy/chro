
import { useCallback, useEffect, useState } from "react";
import { ResizableSidebar } from "@/sidebar/resizable-sidebar";
import { getUiValue, setUiValue } from "@/lib/ui-state-client";
import { FileTree } from "./file-tree/file-tree";

const FILES_SIDEBAR_STORAGE_KEY = "files-sidebar-width";
const FILES_SIDEBAR_DEFAULT_WIDTH = 280;

type FilesSidebarProps = {
  collapsed?: boolean;
  onToggle?: () => void;
};

export const FilesSidebar = ({
  collapsed: controlledCollapsed,
  onToggle,
}: FilesSidebarProps) => {
  const [width, setWidth] = useState(FILES_SIDEBAR_DEFAULT_WIDTH);
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [peek, setPeek] = useState(false);

  const collapsed = controlledCollapsed ?? internalCollapsed;

  useEffect(() => {
    const stored = getUiValue<number>(FILES_SIDEBAR_STORAGE_KEY);
    if (stored !== null && !Number.isNaN(stored)) {
      setWidth(stored);
    }
  }, []);

  useEffect(() => {
    setUiValue(FILES_SIDEBAR_STORAGE_KEY, width);
  }, [width]);

  const handleToggleCollapsed = useCallback(
    (value?: boolean) => {
      if (onToggle) {
        onToggle();
      } else {
        setInternalCollapsed((prev) =>
          typeof value === "boolean" ? value : !prev,
        );
      }
    },
    [onToggle],
  );

  const handleTogglePeek = useCallback((value?: boolean) => {
    setPeek((prev) => (typeof value === "boolean" ? value : !prev));
  }, []);

  return (
    <ResizableSidebar
      width={width}
      setWidth={setWidth}
      defaultWidth={FILES_SIDEBAR_DEFAULT_WIDTH}
      minWidth={220}
      maxWidth={400}
      isCollapsed={collapsed}
      toggleCollapsed={handleToggleCollapsed}
      showPeek={peek}
      togglePeek={handleTogglePeek}
      disablePeekTrigger={true}
      sidebarClassName="bg-custom-sidebar-background-90"
    >
      <div className="flex h-full flex-col overflow-hidden">
        <FileTree onClose={() => handleToggleCollapsed(true)} />
      </div>
    </ResizableSidebar>
  );
};
