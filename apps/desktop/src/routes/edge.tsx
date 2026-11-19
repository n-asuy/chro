import { EdgeToolbarApp } from "@/edge-toolbar/components/edge-toolbar-app";
import { createFileRoute } from "@tanstack/react-router";

/** The edge toolbar window's content (see `src-tauri/src/windows/edge.rs`). */
export const Route = createFileRoute("/edge")({
  component: EdgeToolbarApp,
});
