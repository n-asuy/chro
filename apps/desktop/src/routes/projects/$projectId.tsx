import { ProjectProvider } from "@/files/context/project-context";
import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  return (
    <ProjectProvider>
      <Outlet />
    </ProjectProvider>
  );
}
