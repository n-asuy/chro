import { useDocumentTitle } from "@/hooks/use-document-title";
import { SettingsPanel } from "@/settings/settings-panel";
import { AppRail } from "@/sidebar/app-rail";
import { AppRailProvider } from "@/sidebar/app-rail-context";
import { ElectronTitlebar } from "@/window/electron-titlebar";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/projects/$projectId/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  useDocumentTitle("Settings");

  useEffect(() => {
    window.desktop?.setWindowMode?.("session");
  }, []);

  return (
    <AppRailProvider>
      <div className="flex h-screen w-full bg-custom-background-90 text-foreground font-sans antialiased overflow-hidden selection:bg-custom-primary-100/20 selection:text-custom-primary-100">
        <ElectronTitlebar />
        <AppRail />

        <div className="flex flex-col flex-1 min-w-0 h-full relative">
          <div className="flex-1 mr-2 mb-2 mt-2 ml-2 relative z-10 bg-custom-background-100 rounded-lg shadow-sm border border-custom-border-200 overflow-hidden">
            <SettingsPanel />
          </div>
        </div>
      </div>
    </AppRailProvider>
  );
}
