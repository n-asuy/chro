import {
  SessionDirectoryProvider,
  createSessionDirectory,
} from "@/session/context/session-directory-context";
import { useInboxTasksStream } from "@/session/hooks";
import { type ReactNode, useEffect, useState } from "react";
import { useOpenSession } from "../hooks/use-open-session";

/**
 * Feeds the session directory from the cross-project task stream (the one the
 * session list already holds open) and opens sessions the way the list does,
 * so a session referenced in a message resolves and opens identically.
 */
export function LayoutSessionDirectory({ children }: { children: ReactNode }) {
  const [directory] = useState(createSessionDirectory);
  const { tasks } = useInboxTasksStream(true);
  const openSession = useOpenSession();

  useEffect(() => {
    directory.update(tasks, openSession);
  }, [directory, tasks, openSession]);

  return (
    <SessionDirectoryProvider value={directory}>
      {children}
    </SessionDirectoryProvider>
  );
}
