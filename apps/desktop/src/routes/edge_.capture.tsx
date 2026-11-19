import { EdgeCaptureApp } from "@/edge-toolbar/components/edge-capture-app";
import { createFileRoute } from "@tanstack/react-router";

/** The region capture window's content (see `src-tauri/src/windows/edge_capture.rs`). */
export const Route = createFileRoute("/edge_/capture")({
  component: EdgeCaptureApp,
});
