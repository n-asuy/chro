import { ProjectProvider } from "@/files/context/project-context";
import { LayoutShell } from "@/workspace-layout/components/layout-shell";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  useEffect(() => {
    window.desktop?.setWindowMode?.("session");
  }, []);

  return (
    <ProjectProvider>
      <LayoutShell />
      {/* Outlet kept so legacy nested routes still mount their hooks
          (route-tab-sync watches the URL). The visual surface is
          rendered by LayoutShell; nested route components are no-op
          shells that drive openTab via params. */}
      <div className="hidden">
        <Outlet />
      </div>
    </ProjectProvider>
  );
}
