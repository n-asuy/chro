import { useEffect, useRef, useState } from "react";

import { useOptionalProjectContext } from "@/files/context/project-context";
import { getBackendBaseUrl } from "@/lib/backend-client";
import { useTerminalConfigStore } from "@/settings/state/terminal-config-store";
import { useLayoutStore } from "../state/layout-store";
import type { PaneLayout, PaneNode } from "../types";
import {
  CanvasTerminal,
  DEFAULT_FONT_FAMILY,
  type TerminalSnapshot,
  type TerminalTypography,
} from "./canvas-terminal";

interface TerminalPaneProps {
  /** Tab id; the underlying terminal session is keyed by this id. */
  tabId: string;
}

type ConnectionState = "connecting" | "open" | "closed" | "error";

interface ConnectionStatus {
  state: ConnectionState;
  exitCode: number | null;
  errorMessage: string | null;
}

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const buildSocketUrl = (
  projectId: string | null,
  cols: number,
  rows: number,
  serverSessionId: string | null,
): string => {
  const base = getBackendBaseUrl().replace(/\/$/, "");
  const wsBase = httpToWs(
    base || (typeof window !== "undefined" ? window.location.origin : ""),
  );
  const params = new URLSearchParams();
  // Reattach to a live shell when we already own one (survives reloads,
  // tab reopen, and brief network drops). The server repaints the current
  // screen from its emulator, then resumes live snapshot streaming.
  if (serverSessionId) params.set("session_id", serverSessionId);
  if (projectId) params.set("project_id", projectId);
  params.set("cols", String(cols));
  params.set("rows", String(rows));
  return `${wsBase}/streams/terminal?${params.toString()}`;
};

// Persisted PTY session id, keyed by tab. localStorage (not the in-memory
// `sessions` map) is what survives a full browser reload: the JS heap is
// gone after reload, but the server PTY lives on and we reattach to it.
const sessionStorageKey = (tabId: string): string =>
  `chro:terminal:session:${tabId}`;

const loadStoredSessionId = (tabId: string): string | null => {
  try {
    return window.localStorage.getItem(sessionStorageKey(tabId));
  } catch {
    return null;
  }
};

const storeSessionId = (tabId: string, serverSessionId: string): void => {
  try {
    window.localStorage.setItem(sessionStorageKey(tabId), serverSessionId);
  } catch {
    /* storage unavailable (private mode / quota) — reattach just won't
       survive a reload, which degrades gracefully to a fresh shell. */
  }
};

const clearStoredSessionId = (tabId: string): void => {
  try {
    window.localStorage.removeItem(sessionStorageKey(tabId));
  } catch {
    /* noop */
  }
};

// Auto-reconnect backoff after an unexpected socket drop while the shell
// is presumed alive server-side.
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 4000;

const encodeBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

interface TerminalSession {
  tabId: string;
  projectId: string | null;
  term: CanvasTerminal;
  socket: WebSocket | null;
  /** Server-assigned PTY id; used to reattach across reconnects. */
  serverSessionId: string | null;
  /** Input queued before the socket opened. */
  pendingInput: Uint8Array[];
  /** Latest grid size reported by the renderer; sent on (re)connect. */
  cols: number;
  rows: number;
  status: ConnectionStatus;
  listeners: Set<(s: ConnectionStatus) => void>;
  attached: HTMLElement | null;
  /** Pending auto-reconnect timer, if a drop is being retried. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  disposed: boolean;
}

const sessions = new Map<string, TerminalSession>();

/** Resolve the persisted terminal config into renderer typography, falling back
 * to the default mono stack when the user hasn't picked a font. */
const resolveTypography = (): TerminalTypography => {
  const config = useTerminalConfigStore.getState().config;
  const family = config.font_family?.trim();
  return {
    fontFamily: family ? family : DEFAULT_FONT_FAMILY,
    fontSize: config.font_size,
    lineHeight: config.line_height,
  };
};

// Load terminal typography once and push later changes to every live session so
// font edits in Settings reflow open terminals immediately.
let terminalConfigSubscribed = false;
const ensureTerminalConfigSubscription = () => {
  if (terminalConfigSubscribed) return;
  terminalConfigSubscribed = true;
  void useTerminalConfigStore.getState().load();
  useTerminalConfigStore.subscribe(() => {
    const typography = resolveTypography();
    for (const session of sessions.values()) {
      session.term.setTypography(typography);
    }
  });
};

const setStatus = (
  session: TerminalSession,
  patch: Partial<ConnectionStatus>,
) => {
  const next = { ...session.status, ...patch };
  if (
    next.state === session.status.state &&
    next.exitCode === session.status.exitCode &&
    next.errorMessage === session.status.errorMessage
  ) {
    return;
  }
  session.status = next;
  for (const listener of session.listeners) listener(next);
};

const sendIfOpen = (session: TerminalSession, payload: object): boolean => {
  const ws = session.socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
};

const sendInput = (session: TerminalSession, bytes: Uint8Array) => {
  if (!sendIfOpen(session, { type: "input", data: encodeBytes(bytes) })) {
    session.pendingInput.push(bytes);
  }
};

const flushPendingInput = (session: TerminalSession) => {
  if (session.pendingInput.length === 0) return;
  const drained = session.pendingInput;
  session.pendingInput = [];
  for (const bytes of drained) {
    sendIfOpen(session, { type: "input", data: encodeBytes(bytes) });
  }
};

const clearReconnectTimer = (session: TerminalSession) => {
  if (session.reconnectTimer !== null) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
};

const scheduleReconnect = (session: TerminalSession) => {
  if (session.disposed) return;
  if (session.reconnectTimer !== null) return;
  // The shell is presumed alive server-side; reattach with the stored
  // session id so the screen repaints and live output resumes.
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** session.reconnectAttempts,
    RECONNECT_MAX_DELAY_MS,
  );
  session.reconnectAttempts += 1;
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    if (session.disposed) return;
    openSocket(session);
  }, delay);
};

const openSocket = (session: TerminalSession) => {
  clearReconnectTimer(session);
  setStatus(session, {
    state: "connecting",
    exitCode: null,
    errorMessage: null,
  });
  const url = buildSocketUrl(
    session.projectId,
    session.cols,
    session.rows,
    session.serverSessionId,
  );
  const socket = new WebSocket(url);
  session.socket = socket;

  socket.onopen = () => {
    session.reconnectAttempts = 0;
    setStatus(session, { state: "open" });
    sendIfOpen(session, {
      type: "resize",
      cols: session.cols,
      rows: session.rows,
    });
    flushPendingInput(session);
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const f = frame as { type?: string };
    switch (f.type) {
      case "ready": {
        // On reattach the id we sent comes back unchanged; on a fresh shell
        // (or after a server restart invalidated our id) it's a new one.
        // Either way the server repaints via the next snapshot frame, so we
        // just record the id for future reconnects.
        const id = (f as { session_id?: string }).session_id;
        if (typeof id === "string" && id) {
          session.serverSessionId = id;
          storeSessionId(session.tabId, id);
        }
        return;
      }
      case "snapshot": {
        const snapshot = (f as { snapshot?: TerminalSnapshot }).snapshot;
        if (snapshot) session.term.setSnapshot(snapshot);
        return;
      }
      case "exit": {
        const code = (f as { code?: number | null }).code;
        // The shell is gone for good — drop the stored id so the next mount
        // starts a fresh session instead of a failed reattach.
        session.serverSessionId = null;
        clearStoredSessionId(session.tabId);
        clearReconnectTimer(session);
        setStatus(session, {
          state: "closed",
          exitCode: typeof code === "number" ? code : null,
        });
        return;
      }
      case "error": {
        const message = (f as { message?: string }).message;
        setStatus(session, {
          state: "error",
          errorMessage: message ?? "Terminal backend error",
        });
        return;
      }
    }
  };

  socket.onerror = () => {
    if (session.disposed) return;
    setStatus(session, {
      state: "error",
      errorMessage: session.status.errorMessage ?? "Terminal connection failed",
    });
  };

  socket.onclose = () => {
    if (session.disposed) return;
    if (session.socket === socket) session.socket = null;
    // A close while the shell is presumed alive (we still hold its id and
    // it hasn't reported exit) is a transient drop — auto-reattach. If the
    // shell exited, the `exit` frame already cleared the id and moved us to
    // the "closed" overlay.
    if (
      session.serverSessionId &&
      (session.status.state === "open" || session.status.state === "connecting")
    ) {
      setStatus(session, { state: "connecting" });
      scheduleReconnect(session);
      return;
    }
    if (
      session.status.state === "open" ||
      session.status.state === "connecting"
    ) {
      setStatus(session, { state: "closed" });
    }
  };
};

const createSession = (
  tabId: string,
  projectId: string | null,
): TerminalSession => {
  const session: TerminalSession = {
    tabId,
    projectId,
    // `term` is assigned below once the callbacks can close over `session`.
    term: undefined as unknown as CanvasTerminal,
    socket: null,
    // Reattach to a shell we owned before a reload, if one is recorded.
    serverSessionId: loadStoredSessionId(tabId),
    pendingInput: [],
    cols: 80,
    rows: 24,
    status: { state: "connecting", exitCode: null, errorMessage: null },
    listeners: new Set(),
    attached: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    disposed: false,
  };

  session.term = new CanvasTerminal({
    onInput: (bytes) => sendInput(session, bytes),
    onResize: (cols, rows) => {
      session.cols = cols;
      session.rows = rows;
      sendIfOpen(session, { type: "resize", cols, rows });
    },
    onScroll: (deltaLines) => {
      sendIfOpen(session, { type: "scroll", delta_lines: deltaLines });
    },
  });

  openSocket(session);
  return session;
};

const attachSession = (session: TerminalSession, container: HTMLElement) => {
  if (session.attached === container) return;
  session.attached = container;
  session.term.mount(container);
  session.term.focus();
};

const detachSession = (session: TerminalSession) => {
  session.attached = null;
  session.term.unmount();
};

const restartSession = (session: TerminalSession) => {
  clearReconnectTimer(session);
  // A restart means "give me a new shell" (project change or the user
  // hitting Restart) — kill the old PTY server-side rather than detaching,
  // then drop the stored id so a brand-new session is created.
  if (session.serverSessionId) {
    sendIfOpen(session, { type: "kill" });
  }
  if (session.socket) {
    try {
      session.socket.close(1000, "restart");
    } catch {
      /* noop */
    }
  }
  session.socket = null;
  session.serverSessionId = null;
  clearStoredSessionId(session.tabId);
  session.reconnectAttempts = 0;
  openSocket(session);
};

const disposeSession = (session: TerminalSession) => {
  if (session.disposed) return;
  session.disposed = true;
  clearReconnectTimer(session);
  // Tab closed by the user → terminate the shell for good. `kill` removes
  // the session server-side so it can't be reattached; clear the stored id
  // so a future tab with the same id doesn't try to resurrect it.
  sendIfOpen(session, { type: "kill" });
  clearStoredSessionId(session.tabId);
  if (session.socket) {
    try {
      session.socket.close(1000, "tab closed");
    } catch {
      /* noop */
    }
  }
  session.term.dispose();
  session.listeners.clear();
};

/** Walk every leaf in a layout and collect its tab ids. */
const collectTabIds = (node: PaneNode, out: Set<string>) => {
  if (node.type === "leaf") {
    for (const tab of node.tabs) out.add(tab.id);
  } else {
    collectTabIds(node.children[0], out);
    collectTabIds(node.children[1], out);
  }
};

const reapClosedSessions = (
  layout: PaneLayout | null,
  layoutProjectId: string | null,
) => {
  if (!layout || !layoutProjectId) return;
  const live = new Set<string>();
  collectTabIds(layout.root, live);
  for (const [tabId, session] of sessions) {
    // Sessions for other projects survive — switching back to that
    // project must reuse the live PTY rather than starting fresh.
    if (session.projectId !== layoutProjectId) continue;
    if (!live.has(tabId)) {
      sessions.delete(tabId);
      disposeSession(session);
    }
  }
};

/**
 * Whether a tab's existing session should adopt `resolvedProjectId` and restart
 * its shell so it opens in that project's cwd.
 *
 * Fires for exactly one case: a shell we opened before the project UUID had
 * resolved (`sessionProjectId === null`). Once the cwd is known we recycle it
 * into the right directory.
 *
 * It must NOT fire when a session already belongs to a project and the resolved
 * id merely changes to a *different* project. A tab lives in exactly one
 * project's persisted layout, so that transition is never a real reparent — it
 * is the transient `projectId` flip during a project switch: the still-mounted
 * pane's effect re-runs with the incoming project's id (child effects run
 * before LayoutShell's parent effect swaps the layout out). Restarting there
 * would `kill` the live PTY and clear its stored id, destroying the previous
 * project's terminal history before the pane even unmounts.
 */
export function shouldAdoptProject(
  sessionProjectId: string | null,
  resolvedProjectId: string | null,
): boolean {
  return resolvedProjectId !== null && sessionProjectId === null;
}

let layoutSubscribed = false;
const ensureLayoutSubscription = () => {
  if (layoutSubscribed) return;
  layoutSubscribed = true;
  const initial = useLayoutStore.getState();
  reapClosedSessions(initial.layout, initial.projectId);
  useLayoutStore.subscribe((state, prev) => {
    // A project switch swaps the entire layout (bindProject), which
    // would otherwise look like every terminal tab being "closed".
    // Skip the reaper on project changes so the previous project's
    // sessions stay alive in the map for reuse on return.
    if (state.projectId !== prev.projectId) return;
    reapClosedSessions(state.layout, state.projectId);
  });
};

export function TerminalPane({ tabId }: TerminalPaneProps) {
  const projectContext = useOptionalProjectContext();
  // Use the resolved project UUID as the session's project key so it can
  // be compared 1:1 against the layout-store's projectId by the reaper.
  // Slugs would diverge (slug vs uuid) and trip false-positive disposals.
  const projectId = projectContext?.projectId ?? null;
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatusState] = useState<ConnectionStatus>(() => {
    const existing = sessions.get(tabId);
    return (
      existing?.status ?? {
        state: "connecting",
        exitCode: null,
        errorMessage: null,
      }
    );
  });

  useEffect(() => {
    ensureLayoutSubscription();
    let session = sessions.get(tabId);
    if (!session) {
      // Create the session even before the project UUID has resolved so the
      // terminal renders immediately instead of a blank pane. The shell
      // opens in $HOME and is recycled below once the project cwd is known.
      // A null projectId never matches the reaper's layoutProjectId, so the
      // session survives until the real id lands.
      session = createSession(tabId, projectId);
      sessions.set(tabId, session);
    } else if (shouldAdoptProject(session.projectId, projectId)) {
      // The cwd just resolved for a shell we opened before the project UUID
      // was known — recycle it so the new shell starts in the right directory.
      // Deliberately scoped to sessions with no project yet: a session that
      // already belongs to a project must survive the transient projectId flip
      // during a project switch, or switching projects would kill its live PTY.
      session.projectId = projectId;
      restartSession(session);
    }
    setStatusState(session.status);
    const listener = (next: ConnectionStatus) => setStatusState(next);
    session.listeners.add(listener);
    if (containerRef.current) attachSession(session, containerRef.current);

    return () => {
      const current = sessions.get(tabId);
      if (!current) return;
      current.listeners.delete(listener);
      detachSession(current);
    };
  }, [tabId, projectId]);

  const showOverlay = status.state === "error" || status.state === "closed";
  const overlayLabel =
    status.state === "error"
      ? status.errorMessage ?? "Terminal error"
      : status.exitCode !== null
        ? `Shell exited (${status.exitCode})`
        : "Disconnected";

  return (
    <div className="relative flex h-full w-full flex-col bg-[#0a0a0a]">
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden p-2"
      />
      {showOverlay ? (
        <div className="absolute right-3 top-3 flex items-center gap-2 rounded border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white/70 shadow">
          <span>{overlayLabel}</span>
          <button
            type="button"
            onClick={() => {
              const session = sessions.get(tabId);
              if (session) restartSession(session);
            }}
            className="rounded border border-white/10 px-2 py-0.5 text-white/80 hover:bg-white/5"
          >
            Restart
          </button>
        </div>
      ) : null}
    </div>
  );
}
