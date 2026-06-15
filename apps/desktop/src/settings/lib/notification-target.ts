import type { StoredTask } from "@/session/types";

/** Route params identifying the session a notification click should reopen. */
export type SessionNotificationTarget = {
  projectId: string;
  taskId: string;
};

/**
 * Resolve the `/projects/$projectId/session/$taskId` params for a task. Mirrors
 * the inbox row navigation: prefer the short slug for clean URLs, fall back to
 * the raw id for backward compatibility (the route resolves either).
 */
export function resolveSessionTarget(
  task: Pick<StoredTask, "id" | "slug" | "project_id">,
  projectsById: Record<string, { slug?: string | null } | undefined>,
): SessionNotificationTarget {
  const project = projectsById[task.project_id];
  return {
    projectId: project?.slug ?? task.project_id,
    taskId: task.slug ?? task.id,
  };
}
