
import { Button } from "@chro/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { PanelLeft, PanelRight } from "lucide-react";
import { useFilesStore } from "../state/files-store";

type FilesPathHeaderProps = {
  isSidebarCollapsed: boolean;
  isRightPanelCollapsed: boolean;
  onOpenSidebar: () => void;
  onOpenRightPanel: () => void;
};

export const FilesPathHeader = ({
  isSidebarCollapsed,
  isRightPanelCollapsed,
  onOpenSidebar,
  onOpenRightPanel,
}: FilesPathHeaderProps) => {
  const { currentFilePath } = useFilesStore();

  return (
    <div className="flex h-11 items-center justify-between bg-custom-background-100 px-2 shrink-0">
      <div className="flex items-center">
        {isSidebarCollapsed && (
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={onOpenSidebar}
                  className="text-[12px] inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100"
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                Open sidebar
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <div className="flex-1 min-w-0 px-2">
        <span className="text-xs text-custom-text-300 truncate block text-center">
          {currentFilePath?.replace(/^\/+/, "") ?? ""}
        </span>
      </div>
      <div className="flex items-center">
        {isRightPanelCollapsed && (
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={onOpenRightPanel}
                  className="text-[12px] inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100"
                >
                  <PanelRight className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                Open panel
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
};
