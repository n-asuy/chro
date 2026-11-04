import { desktopFetch } from "@/lib/backend-client";
import type { TaskContextRef } from "@/session/lib/session-relations";
import { useQuery } from "@tanstack/react-query";

type TaskContextRefsResponse = {
  refs: TaskContextRef[];
};

export type SessionContextRefs = {
  outgoing: TaskContextRef[];
  incoming: TaskContextRef[];
};

const fetchSessionContextRefs = async (
  taskId: string,
): Promise<SessionContextRefs> => {
  const encoded = encodeURIComponent(taskId);
  const [outgoing, incoming] = await Promise.all([
    desktopFetch<TaskContextRefsResponse>(`/rpc/tasks/${encoded}/context-refs`),
    desktopFetch<TaskContextRefsResponse>(
      `/rpc/tasks/${encoded}/referenced-by`,
    ),
  ]);
  return {
    outgoing: outgoing.refs,
    incoming: incoming.refs,
  };
};

/**
 * The context-ref edges a session holds and the ones pointing at it. One
 * query per session, shared by the Refs popover and the left panel so both
 * read the same relations.
 */
export function useSessionContextRefs(taskId: string | null | undefined) {
  return useQuery({
    queryKey: ["task-context-refs", taskId],
    queryFn: () => fetchSessionContextRefs(taskId ?? ""),
    enabled: Boolean(taskId),
    staleTime: 10_000,
  });
}
