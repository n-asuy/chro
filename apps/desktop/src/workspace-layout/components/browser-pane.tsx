import {
  ArrowLeft,
  ArrowRight,
  EyeOff,
  Monitor,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { getBackendBaseUrl } from "@/lib/backend-client";
import { useLayoutStore } from "../state/layout-store";
import type { PaneLayout, PaneNode } from "../types";
import {
  CanvasBrowser,
  type MouseButton,
  type ScreencastMetadata,
} from "./canvas-browser";

interface BrowserPaneProps {
  /** Tab id; the underlying browser session is keyed by this id. */
  tabId: string;
  /** Optional initial URL to open with the session. */
  initialUrl?: string;
}

type ConnectionState = "connecting" | "open" | "closed" | "error";

interface PageState {
  target_id: string;
  url: string;
  title: string;
}

interface TabInfo {
  targetId: string;
  title: string;
  url: string;
}

interface BrowserStatus {
  state: ConnectionState;
  errorMessage: string | null;
  page: PageState | null;
  tabs: TabInfo[];
  /** Whether the backing Chrome runs headless (no OS window) or headful. */
  headless: boolean;
}

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const buildSocketUrl = (
  initialUrl: string | undefined,
  headless: boolean,
): string => {
  const base = getBackendBaseUrl().replace(/\/$/, "");
  const wsBase = httpToWs(
    base || (typeof window !== "undefined" ? window.location.origin : ""),
  );
  const params = new URLSearchParams();
  if (initialUrl) params.set("url", initialUrl);
  params.set("headless", String(headless));
  return `${wsBase}/streams/browser?${params.toString()}`;
};

interface BrowserSession {
  tabId: string;
  view: CanvasBrowser;
  socket: WebSocket | null;
  /** Latest viewport size reported by the renderer; sent on (re)connect. */
  width: number;
  height: number;
  status: BrowserStatus;
  listeners: Set<(s: BrowserStatus) => void>;
  attached: HTMLElement | null;
  disposed: boolean;
  initialUrl?: string;
  /** Launch mode for the (re)connect. Toggled by the headful/headless button. */
  headless: boolean;
}

const sessions = new Map<string, BrowserSession>();

const setStatus = (session: BrowserSession, patch: Partial<BrowserStatus>) => {
  session.status = { ...session.status, ...patch };
  for (const listener of session.listeners) listener(session.status);
};

const sendIfOpen = (session: BrowserSession, payload: object): boolean => {
  const ws = session.socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
};

const openSocket = (session: BrowserSession) => {
  setStatus(session, {
    state: "connecting",
    errorMessage: null,
    headless: session.headless,
  });
  const socket = new WebSocket(
    buildSocketUrl(session.initialUrl, session.headless),
  );
  session.socket = socket;

  socket.onopen = () => {
    setStatus(session, { state: "open" });
    if (session.width > 0 && session.height > 0) {
      sendIfOpen(session, {
        type: "resize",
        width: session.width,
        height: session.height,
      });
    }
    sendIfOpen(session, { type: "list_tabs" });
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
      case "ready":
        return;
      case "frame": {
        const { data, metadata } = f as {
          data?: string;
          metadata?: ScreencastMetadata;
        };
        if (data && metadata) session.view.setFrame(data, metadata);
        return;
      }
      case "state": {
        const state = (f as { state?: PageState }).state;
        if (state) setStatus(session, { page: state });
        return;
      }
      case "tabs": {
        const tabs = (f as { tabs?: TabInfo[] }).tabs;
        if (tabs) setStatus(session, { tabs });
        return;
      }
      case "error": {
        const message = (f as { message?: string }).message;
        setStatus(session, {
          state: "error",
          errorMessage: message ?? "Browser backend error",
        });
        return;
      }
    }
  };

  socket.onerror = () => {
    if (session.disposed) return;
    setStatus(session, {
      state: "error",
      errorMessage: session.status.errorMessage ?? "Browser connection failed",
    });
  };

  socket.onclose = () => {
    if (session.disposed) return;
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
  initialUrl: string | undefined,
): BrowserSession => {
  const session: BrowserSession = {
    tabId,
    view: undefined as unknown as CanvasBrowser,
    socket: null,
    width: 0,
    height: 0,
    // Headless by default — no OS window, only the in-pane live view.
    headless: true,
    status: {
      state: "connecting",
      errorMessage: null,
      page: null,
      tabs: [],
      headless: true,
    },
    listeners: new Set(),
    attached: null,
    disposed: false,
    initialUrl,
  };

  session.view = new CanvasBrowser({
    onClick: (x, y, button: MouseButton, clicks) =>
      sendIfOpen(session, { type: "click", x, y, button, clicks }),
    onScroll: (x, y, dx, dy) =>
      sendIfOpen(session, { type: "scroll", x, y, dx, dy }),
    onKey: (key, modifiers) =>
      sendIfOpen(session, { type: "key", key, modifiers }),
    onResize: (width, height) => {
      session.width = width;
      session.height = height;
      sendIfOpen(session, { type: "resize", width, height });
    },
  });

  openSocket(session);
  return session;
};

const restartSession = (session: BrowserSession) => {
  if (session.socket) {
    try {
      session.socket.close(1000, "restart");
    } catch {
      /* noop */
    }
  }
  session.socket = null;
  openSocket(session);
};

const disposeSession = (session: BrowserSession) => {
  if (session.disposed) return;
  session.disposed = true;
  if (session.socket) {
    try {
      session.socket.close(1000, "tab closed");
    } catch {
      /* noop */
    }
  }
  session.view.dispose();
  session.listeners.clear();
  sessions.delete(session.tabId);
};

export function BrowserPane({ tabId, initialUrl }: BrowserPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatusState] = useState<BrowserStatus>(() => {
    const existing = sessions.get(tabId);
    return (
      existing?.status ?? {
        state: "connecting",
        errorMessage: null,
        page: null,
        tabs: [],
        headless: true,
      }
    );
  });
  const [urlInput, setUrlInput] = useState("");

  useEffect(() => {
    ensureLayoutSubscription();
    let session = sessions.get(tabId);
    if (!session) {
      session = createSession(tabId, initialUrl);
      sessions.set(tabId, session);
    }
    setStatusState(session.status);
    const listener = (next: BrowserStatus) => setStatusState(next);
    session.listeners.add(listener);
    if (containerRef.current) {
      session.attached = containerRef.current;
      session.view.mount(containerRef.current);
      session.view.focus();
    }

    return () => {
      const current = sessions.get(tabId);
      if (!current) return;
      current.listeners.delete(listener);
      current.attached = null;
      current.view.unmount();
    };
  }, [tabId, initialUrl]);

  // Reflect the live page address into the editable URL bar.
  useEffect(() => {
    if (status.page?.url) setUrlInput(status.page.url);
  }, [status.page?.url]);

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    const session = sessions.get(tabId);
    if (!session) return;
    const url = normalizeUrl(urlInput);
    sendIfOpen(session, { type: "navigate", url });
  };

  const send = (payload: object) => {
    const session = sessions.get(tabId);
    if (session) sendIfOpen(session, payload);
  };

  // Switching headless↔headful needs a fresh Chrome process (the flag is fixed
  // at launch), so we relaunch the session — carrying the current page over so
  // the switch feels seamless.
  const toggleHeadless = () => {
    const session = sessions.get(tabId);
    if (!session) return;
    const currentUrl = session.status.page?.url;
    session.headless = !session.headless;
    if (currentUrl && !currentUrl.startsWith("about:")) {
      session.initialUrl = currentUrl;
    }
    restartSession(session);
  };

  const showOverlay = status.state === "error" || status.state === "closed";

  return (
    <div className="relative flex h-full w-full flex-col bg-[#0a0a0a]">
      <div className="flex items-center gap-1 border-b border-white/10 bg-black/40 px-2 py-1.5">
        <button
          type="button"
          title="Back"
          onClick={() => send({ type: "back" })}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-white/50 hover:bg-white/5 hover:text-white/80"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Forward"
          onClick={() => send({ type: "forward" })}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-white/50 hover:bg-white/5 hover:text-white/80"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Reload"
          onClick={() => {
            const session = sessions.get(tabId);
            if (session?.status.page?.url) {
              sendIfOpen(session, {
                type: "navigate",
                url: session.status.page.url,
              });
            }
          }}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-white/50 hover:bg-white/5 hover:text-white/80"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <form onSubmit={submitUrl} className="flex-1">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL…"
            spellCheck={false}
            className="h-6 w-full rounded bg-white/5 px-2 text-[12px] text-white/85 outline-none placeholder:text-white/30 focus:bg-white/10"
          />
        </form>
        <button
          type="button"
          title={
            status.headless
              ? "実ウィンドウで開く (headful)"
              : "ヘッドレスに戻す"
          }
          onClick={toggleHeadless}
          className={`inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/5 hover:text-white/80 ${
            status.headless ? "text-white/50" : "text-sky-400"
          }`}
        >
          {status.headless ? (
            <Monitor className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          title="New tab"
          onClick={() => send({ type: "new_tab", url: "about:blank" })}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-white/50 hover:bg-white/5 hover:text-white/80"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={
            status.headless
              ? "Open in a real Chrome window (headful)"
              : "Switch back to headless (in-pane only)"
          }
          onClick={toggleHeadless}
          className={`inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/5 hover:text-white/80 ${
            status.headless ? "text-white/50" : "text-sky-400"
          }`}
        >
          {status.headless ? (
            <Monitor className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {status.tabs.length > 1 ? (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-white/10 bg-black/20 px-2 py-1">
          {status.tabs.map((tab) => {
            const active = tab.targetId === status.page?.target_id;
            return (
              <div
                key={tab.targetId}
                className={`group flex max-w-[180px] items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                  active
                    ? "bg-white/15 text-white/90"
                    : "bg-white/5 text-white/55 hover:bg-white/10"
                }`}
              >
                <button
                  type="button"
                  onClick={() =>
                    send({ type: "switch_tab", target_id: tab.targetId })
                  }
                  className="truncate"
                  title={tab.url}
                >
                  {tab.title || tab.url || "Untitled"}
                </button>
                <button
                  type="button"
                  title="Close tab"
                  onClick={() =>
                    send({ type: "close_tab", target_id: tab.targetId })
                  }
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden"
      />

      {showOverlay ? (
        <div className="absolute right-3 top-12 flex items-center gap-2 rounded border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white/70 shadow">
          <span>{status.errorMessage ?? "Disconnected"}</span>
          <button
            type="button"
            onClick={() => {
              const session = sessions.get(tabId);
              if (session) restartSession(session);
            }}
            className="rounded border border-white/10 px-2 py-0.5 text-white/80 hover:bg-white/5"
          >
            Reconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Walk every leaf in a layout and collect its tab ids. */
const collectTabIds = (node: PaneNode, out: Set<string>) => {
  if (node.type === "leaf") {
    for (const tab of node.tabs) out.add(tab.id);
  } else {
    collectTabIds(node.children[0], out);
    collectTabIds(node.children[1], out);
  }
};

/** Dispose browser sessions whose tab no longer exists in the layout, killing
 * the backing Chrome. */
const reapClosedSessions = (layout: PaneLayout | null) => {
  if (!layout) return;
  const live = new Set<string>();
  collectTabIds(layout.root, live);
  for (const [tabId, session] of sessions) {
    if (!live.has(tabId)) disposeSession(session);
  }
};

let layoutSubscribed = false;
const ensureLayoutSubscription = () => {
  if (layoutSubscribed) return;
  layoutSubscribed = true;
  reapClosedSessions(useLayoutStore.getState().layout);
  useLayoutStore.subscribe((state, prev) => {
    // A project switch swaps the entire layout; skip the reaper so a browser
    // tab in the previous project's layout isn't killed mid-switch.
    if (state.projectId !== prev.projectId) return;
    reapClosedSessions(state.layout);
  });
};

/** Prepend `https://` to a bare host and treat a search-like string as a query. */
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    trimmed.startsWith("about:")
  ) {
    return trimmed;
  }
  // A token with a dot and no spaces looks like a domain; otherwise search.
  if (/^[^\s]+\.[^\s]+$/.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}
