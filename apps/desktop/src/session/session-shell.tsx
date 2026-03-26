import { useCallback, useEffect, useState } from "react";
import { AppRail } from "@/sidebar/app-rail";
import { AppRailProvider } from "@/sidebar/app-rail-context";
import { ElectronTitlebar } from "@/window/electron-titlebar";
import { getUiValue, setUiValue } from "@/lib/ui-state-client";

import { ProjectProvider } from "@/files/context/project-context";
import { SingleAgentSessionView } from "./single-agent-session";

const SESSION_SIDEBAR_COLLAPSED_KEY = "desktop:session-sidebar-collapsed";

export const SessionShell = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => getUiValue<boolean>(SESSION_SIDEBAR_COLLAPSED_KEY) ?? false,
  );

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev: boolean) => !prev);
  }, []);

  useEffect(() => {
    window.desktop?.setWindowMode?.("session");
  }, []);

  useEffect(() => {
    setUiValue(SESSION_SIDEBAR_COLLAPSED_KEY, sidebarCollapsed);
  }, [sidebarCollapsed]);

  return (
    <AppRailProvider>
      <ProjectProvider>
        <div
          className="flex h-screen w-full bg-custom-background-90 text-foreground font-sans antialiased overflow-hidden selection:bg-custom-primary-100/20 selection:text-custom-primary-100"
        >
          <ElectronTitlebar />
          <AppRail />

          <div className="flex flex-col flex-1 min-w-0 h-full relative">
            <div className="flex-1 mr-2 mb-2 mt-2 ml-2 relative z-10 bg-custom-background-100 rounded-lg shadow-sm border border-custom-border-200 overflow-hidden">
              <SingleAgentSessionView
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
              />
            </div>
          </div>
        </div>
      </ProjectProvider>
    </AppRailProvider>
  );
};
