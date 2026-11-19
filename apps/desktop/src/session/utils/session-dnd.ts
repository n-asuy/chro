export const SESSION_DRAG_DATA_TYPE = "application/x-chro-session-reference";

export interface SessionDragPayload {
  taskId: string;
  branch: string | null;
  /** Shown on the pill the drop creates; empty when the session is untitled. */
  title: string;
}

export function serializeSessionDragPayload(
  payload: SessionDragPayload,
): string {
  return JSON.stringify(payload);
}

export function parseSessionDragPayload(
  value: string | null | undefined,
): SessionDragPayload | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SessionDragPayload>;
    if (typeof parsed.taskId !== "string" || parsed.taskId.length === 0) {
      return null;
    }
    return {
      taskId: parsed.taskId,
      branch: typeof parsed.branch === "string" ? parsed.branch : null,
      title: typeof parsed.title === "string" ? parsed.title : "",
    };
  } catch {
    return null;
  }
}
