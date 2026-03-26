import ExploreLayout from "@/explore";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/projects/$projectId/explore")({
  component: ExplorePage,
});

function ExplorePage() {
  const { projectId } = Route.useParams();

  useEffect(() => {
    window.desktop?.setWindowMode?.("session");
  }, []);

  return <ExploreLayout projectId={projectId} />;
}
