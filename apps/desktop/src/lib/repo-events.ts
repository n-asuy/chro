/**
 * Framework-free client for the notification-only repo-events streams
 * (`/streams/task-runs/:id/repo-events`, `/streams/projects/:id/repo-events`).
 *
 * The server multiplexes two change signal sources per worktree — file batches
 * and git metadata state — and this module turns them into debounced
 * `onInvalidate` calls. No data travels on the stream: consumers react by
 * re-running the RPC they already use. Connection sharing, reconnect backoff,
 * and teardown come from the shared stream registry, so any number of
 * consumers of the same scope share one socket.
 */
import { getBackendBaseUrl } from "@/lib/backend-client";
import type { GitScope } from "@/lib/git-client";
import {
  type LogEntryMessage,
  acquireStream,
} from "../session/hooks/json-patch-stream-registry";

export type GitStateKind = "headMoved" | "indexChanged" | "operationChanged";

export type RepoEventPayload =
  /** `paths` omitted means "too many to enumerate": match any filter. */
  | { channel: "files"; paths?: string[] }
  | { channel: "git"; kinds: GitStateKind[] }
  /** Notifications were lost (broadcast lag): refresh unconditionally. */
  | { channel: "resync" };

export type RepoEventChannel = "files" | "git";

export interface RepoEventsConfig {
  /** Which channels should trigger invalidation. */
  channels: readonly RepoEventChannel[];
  /** For the git channel: which kinds matter. Omitted = all. */
  gitKinds?: readonly GitStateKind[];
  /** For the files channel: which paths matter. Omitted = all. */
  pathFilter?: (path: string) => boolean;
  /** Debounced change trigger; also fired once per reconnect (resync). */
  onInvalidate: () => void;
}

/** Collapse an event burst (e.g. a checkout touching many files) into one refresh. */
const INVALIDATE_DEBOUNCE_MS = 300;

export function repoEventsEndpoint(scope: GitScope): string {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  return "taskRunId" in scope
    ? `${baseUrl}/streams/task-runs/${encodeURIComponent(scope.taskRunId)}/repo-events`
    : `${baseUrl}/streams/projects/${encodeURIComponent(scope.projectId)}/repo-events`;
}

function parsePayload(payload: unknown): RepoEventPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const channel = (payload as { channel?: unknown }).channel;
  if (channel !== "files" && channel !== "git" && channel !== "resync") {
    return null;
  }
  return payload as RepoEventPayload;
}

/** Whether a payload is relevant under `config` (resync always is). */
export function repoEventMatches(
  payload: RepoEventPayload,
  config: RepoEventsConfig,
): boolean {
  switch (payload.channel) {
    case "resync":
      return true;
    case "files": {
      if (!config.channels.includes("files")) return false;
      if (!payload.paths || !config.pathFilter) return true;
      return payload.paths.some(config.pathFilter);
    }
    case "git": {
      if (!config.channels.includes("git")) return false;
      if (!config.gitKinds) return true;
      const wanted = config.gitKinds;
      return payload.kinds.some((kind) => wanted.includes(kind));
    }
  }
}

/**
 * Subscribe `endpoint` and call the config's `onInvalidate` (debounced) for
 * every relevant notification. The config is re-read through `getConfig` on
 * each event, so callers may hand in changing callbacks without resubscribing.
 * Returns a dispose function.
 */
export function subscribeRepoEvents(
  endpoint: string,
  getConfig: () => RepoEventsConfig,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let everConnected = false;
  let disposed = false;

  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!disposed) getConfig().onInvalidate();
    }, INVALIDATE_DEBOUNCE_MS);
  };

  const onMessage = (message: LogEntryMessage) => {
    if (message.type !== "repo_event") return;
    const payload = parsePayload(message.payload);
    if (payload && repoEventMatches(payload, getConfig())) schedule();
  };

  const release = acquireStream(
    endpoint,
    () => ({}),
    {
      // No document to render; invalidation flows through onMessage.
      notify: () => {},
      getOptions: () => ({
        expectInitialMessage: false,
        onMessage,
        onConnect: () => {
          // The consumer's own initial fetch covers the first connect; a
          // RE-connect means events may have been missed while offline.
          if (everConnected) schedule();
          everConnected = true;
        },
      }),
    },
    false,
  );

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    release();
  };
}
