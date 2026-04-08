import {
  ProjectProvider,
  useOptionalProjectContext,
} from "@/files/context/project-context";
import { GlobalSearchProjectSync } from "@/search/global-search-provider";
import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  return (
    <ProjectProvider>
      <ProjectSearchSync />
      <Outlet />
    </ProjectProvider>
  );
}

function ProjectSearchSync() {
  const ctx = useOptionalProjectContext();
  return (
    <GlobalSearchProjectSync
      projectId={ctx?.projectId ?? null}
      projectSlug={ctx?.projectSlug ?? null}
    />
  );
}
