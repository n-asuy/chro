import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

interface NativeBrowserPaneProps {
  /** Tab id; used to derive a unique, stable webview label prefix. */
  tabId: string;
  /** Optional initial URL to load. */
  initialUrl?: string;
}

const HOME = "about:blank";

/**
 * Force a full Safari User-Agent on macOS. WKWebView's *default* UA omits the
 * `Version/… Safari/…` tokens (it ends at `AppleWebKit/605.1.15 (KHTML, like
 * Gecko)`), and many sites — Google most visibly — read that as an unknown/old
 * browser and serve a stripped-down legacy UI ("古い感じ"). cmux solves this by
 * setting `webView.customUserAgent`; Tauri exposes the same knob as the
 * `userAgent` creation option. Windows (WebView2) already reports a modern
 * Edge/Chromium UA, so we only override on macOS — claiming to be Mac Safari on
 * Windows would be a lie that sites can detect.
 */
const MAC_SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15";

const isMac = (): boolean =>
  window.__CHRO_RUNTIME__?.platform === "darwin" ||
  navigator.platform.toLowerCase().includes("mac");

/**
 * In-app browser backed by a **native embedded webview** (Tauri 2 `unstable`
 * multi-webview → WKWebView on macOS, WebView2 on Windows). This is the real
 * cmux-equivalent: the page is a top-level native browser surface, so unlike an
 * iframe it is NOT subject to `X-Frame-Options`/CSP `frame-ancestors` and loads
 * any site.
 *
 * The native webview is a separate OS layer that floats above the DOM, so this
 * component owns a placeholder `<div>` and continuously syncs the webview's
 * position/size to that div's rect, hiding it when the pane is not visible
 * (tab switched away, collapsed). The webview is positioned over the content
 * area only — the toolbar stays in the DOM above it.
 *
 * The JS API has no "navigate" method (URL is fixed at creation), so navigation
 * recreates the webview at the same rect with the new URL.
 */

let webviewSeq = 0;

export function NativeBrowserPane({
  tabId,
  initialUrl,
}: NativeBrowserPaneProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const available = useMemo(() => isTauri(), []);

  const start = useMemo(
    () => normalizeUrl(initialUrl ?? "", HOME),
    [initialUrl],
  );
  const [history, setHistory] = useState<string[]>([start]);
  const [cursor, setCursor] = useState(0);
  const [urlInput, setUrlInput] = useState(start === HOME ? "" : start);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [failed, setFailed] = useState(false);

  const current = history[cursor] ?? HOME;
  const canBack = cursor > 0;
  const canForward = cursor < history.length - 1;

  const labelPrefix = useMemo(
    () => `browser-${tabId.replace(/[^a-zA-Z0-9\-/:_]/g, "_")}`,
    [tabId],
  );

  // Create the native webview over the slot and keep its geometry in sync.
  // Re-runs on navigation (current) and reload (reloadNonce): each creates a
  // fresh webview, since the embedded API cannot navigate in place.
  useEffect(() => {
    if (!available) return;
    const slot = slotRef.current;
    if (!slot) return;

    let closed = false;
    let raf = 0;
    const last = { x: -1, y: -1, w: -1, h: -1, shown: false };

    const rectNow = () => {
      const r = slot.getBoundingClientRect();
      const visible = r.width > 1 && r.height > 1 && slot.offsetParent !== null;
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible,
      };
    };

    const initial = rectNow();
    webviewSeq += 1;
    const label = `${labelPrefix}-${webviewSeq}`;
    const wv = new Webview(getCurrentWindow(), label, {
      url: current,
      x: initial.x,
      y: initial.y,
      width: Math.max(initial.w, 1),
      height: Math.max(initial.h, 1),
      // See MAC_SAFARI_USER_AGENT: avoid WKWebView's tokenless default UA that
      // makes sites serve their legacy layout. Omit on Windows (modern default).
      ...(isMac() ? { userAgent: MAC_SAFARI_USER_AGENT } : {}),
    });
    wv.once("tauri://error", (event) => {
      console.error("native browser webview error", event);
      setFailed(true);
    });

    // Position/visibility sync loop. setPosition/setSize/show/hide return
    // promises; we fire-and-forget and dedupe against the last applied rect.
    const tick = () => {
      if (closed) return;
      const r = rectNow();
      if (r.visible) {
        if (r.x !== last.x || r.y !== last.y) {
          last.x = r.x;
          last.y = r.y;
          void wv.setPosition(new LogicalPosition(r.x, r.y)).catch(() => {});
        }
        if (r.w !== last.w || r.h !== last.h) {
          last.w = r.w;
          last.h = r.h;
          void wv
            .setSize(new LogicalSize(Math.max(r.w, 1), Math.max(r.h, 1)))
            .catch(() => {});
        }
        if (!last.shown) {
          last.shown = true;
          void wv.show().catch(() => {});
        }
      } else if (last.shown) {
        last.shown = false;
        void wv.hide().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      closed = true;
      cancelAnimationFrame(raf);
      void wv.close().catch(() => {});
    };
  }, [available, current, reloadNonce, labelPrefix]);

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw, HOME);
    setFailed(false);
    setHistory((prev) => {
      const trimmed = prev.slice(0, cursor + 1);
      if (trimmed[trimmed.length - 1] === url) return prev;
      return [...trimmed, url];
    });
    setCursor((c) => (history[c] === url ? c : c + 1));
    setUrlInput(url === HOME ? "" : url);
  };

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    navigate(urlInput);
  };

  const goBack = () => {
    if (!canBack) return;
    const next = cursor - 1;
    setCursor(next);
    setUrlInput(history[next] === HOME ? "" : history[next]);
  };

  const goForward = () => {
    if (!canForward) return;
    const next = cursor + 1;
    setCursor(next);
    setUrlInput(history[next] === HOME ? "" : history[next]);
  };

  const reload = () => setReloadNonce((n) => n + 1);

  if (!available) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-neutral-50 p-6 text-center text-[13px] text-neutral-500">
        The native browser is only available in the desktop app.
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-white">
      <div className="flex items-center gap-1 border-b border-black/10 bg-neutral-100 px-2 py-1.5">
        <button
          type="button"
          title="Back"
          disabled={!canBack}
          onClick={goBack}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-600 enabled:hover:bg-black/5 enabled:hover:text-neutral-900 disabled:opacity-30"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Forward"
          disabled={!canForward}
          onClick={goForward}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-600 enabled:hover:bg-black/5 enabled:hover:text-neutral-900 disabled:opacity-30"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Reload"
          onClick={reload}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-600 hover:bg-black/5 hover:text-neutral-900"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <form onSubmit={submitUrl} className="flex-1">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL…"
            spellCheck={false}
            className="h-6 w-full rounded bg-white px-2 text-[12px] text-neutral-800 outline-none ring-1 ring-black/10 placeholder:text-neutral-400 focus:ring-black/20"
          />
        </form>
      </div>

      {/* Placeholder the native webview is positioned over. The checkerboard-ish
          neutral fill shows only in the brief gap before the webview paints. */}
      <div ref={slotRef} className="relative min-h-0 flex-1 bg-neutral-50">
        {failed ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[13px] text-neutral-500">
            Couldn't load this page.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Normalize bar input to a URL: bare host → https, search text → Google. */
function normalizeUrl(input: string, fallback: string): string {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    trimmed.startsWith("about:")
  ) {
    return trimmed;
  }
  if (/^[^\s]+\.[^\s]+$/.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}
