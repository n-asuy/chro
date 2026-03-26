import { KanbanBoard } from "@/kanban/components/kanban-board";
import { IssuePeekOverlay } from "@/kanban/components/issue-peek-overlay";
import { AppRail } from "@/sidebar/app-rail";
import { AppRailProvider } from "@/sidebar/app-rail-context";
import { ElectronTitlebar } from "@/window/electron-titlebar";


export const WorkspaceShell = () => {
  return (
    <AppRailProvider>
      <div
        className="flex h-screen w-full bg-custom-background-90 text-foreground font-sans antialiased overflow-hidden selection:bg-custom-primary-100/20 selection:text-custom-primary-100"
      >
        <ElectronTitlebar />

        {/* Navigation Rail */}
        <AppRail />

        {/* Main Content Area */}
        <div className="flex flex-col flex-1 min-w-0 h-full relative">
          {/* Content Card */}
          <div className="flex-1 mr-2 mb-2 mt-2 ml-2 relative z-10 bg-custom-background-100 rounded-lg shadow-sm border border-custom-border-200 overflow-hidden">
            <div
              id="full-screen-portal"
              className="absolute inset-0 w-full"
            />
            <div className="relative h-full w-full overflow-x-hidden overflow-y-scroll">
              <div className="relative h-full w-full px-5 py-5">
                <KanbanBoard />
              </div>
            </div>
          </div>
        </div>
      </div>
      <IssuePeekOverlay />
    </AppRailProvider>
  );
};
