import { useLanguage } from "@/i18n";
import { getBackendBaseUrl } from "@/lib/backend-client";
import type { BaseCodingAgent } from "@/lib/executor-client";
import {
  CanvasTerminal,
  DEFAULT_FONT_FAMILY,
  type TerminalSnapshot,
} from "@/workspace-layout/components/canvas-terminal";
import { Button } from "@chro/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chro/ui/dialog";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const EXECUTOR_LABELS: Record<BaseCodingAgent, string> = {
  CLAUDE_CODE: "Claude Code",
  CODEX: "Codex",
  PI: "pi",
};

type LoginTerminalDialogProps = {
  /** Agent to sign in, or `null` when the dialog is closed. */
  agent: BaseCodingAgent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired once the login CLI exits successfully (code 0). */
  onAuthenticated?: (agent: BaseCodingAgent) => void;
};

type SessionState = "connecting" | "running" | "success" | "failed" | "error";

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const encodeBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const buildLoginSocketUrl = (
  agent: BaseCodingAgent,
  cols: number,
  rows: number,
): string => {
  const base = getBackendBaseUrl().replace(/\/$/, "");
  const wsBase = httpToWs(
    base || (typeof window !== "undefined" ? window.location.origin : ""),
  );
  const params = new URLSearchParams();
  params.set("login", agent);
  params.set("cols", String(cols));
  params.set("rows", String(rows));
  return `${wsBase}/streams/terminal?${params.toString()}`;
};

/**
 * Hosts an executor's interactive login CLI in a live terminal.
 *
 * The server spawns the agent's callback-free login (codex device auth /
 * claude token flow) in a PTY and streams its grid here, so the device-code
 * prompt completes inside the app without a browser redirect. That makes one
 * path serve both local and headless (remote server) installs.
 */
export function LoginTerminalDialog({
  agent,
  open,
  onOpenChange,
  onAuthenticated,
}: LoginTerminalDialogProps) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const termRef = useRef<CanvasTerminal | null>(null);
  const colsRef = useRef(80);
  const rowsRef = useRef(24);
  const [state, setState] = useState<SessionState>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Bumped to force a fresh login session (Retry).
  const [attempt, setAttempt] = useState(0);
  // Hold the latest callback in a ref so the session effect does not re-run
  // (and restart the login) when a parent passes a fresh inline function.
  const onAuthenticatedRef = useRef(onAuthenticated);
  useEffect(() => {
    onAuthenticatedRef.current = onAuthenticated;
  }, [onAuthenticated]);

  const teardown = useCallback(() => {
    const socket = socketRef.current;
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "kill" }));
        }
        socket.close(1000, "login dialog closed");
      } catch {
        /* noop */
      }
    }
    socketRef.current = null;
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open || !agent) {
      teardown();
      return undefined;
    }

    setState("connecting");
    setExitCode(null);
    setErrorMessage(null);

    const term = new CanvasTerminal(
      {
        onInput: (bytes) => {
          const socket = socketRef.current;
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({ type: "input", data: encodeBytes(bytes) }),
            );
          }
        },
        onResize: (cols, rows) => {
          colsRef.current = cols;
          rowsRef.current = rows;
          const socket = socketRef.current;
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        },
        onScroll: (deltaLines) => {
          const socket = socketRef.current;
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({ type: "scroll", delta_lines: deltaLines }),
            );
          }
        },
      },
      {
        fontFamily: DEFAULT_FONT_FAMILY,
        fontSize: 13,
        lineHeight: 1.4,
      },
    );
    termRef.current = term;
    if (containerRef.current) {
      term.mount(containerRef.current);
      term.focus();
    }

    const socket = new WebSocket(
      buildLoginSocketUrl(agent, colsRef.current, rowsRef.current),
    );
    socketRef.current = socket;

    socket.onopen = () => {
      setState("running");
      socket.send(
        JSON.stringify({
          type: "resize",
          cols: colsRef.current,
          rows: rowsRef.current,
        }),
      );
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
        case "snapshot": {
          const snapshot = (f as { snapshot?: TerminalSnapshot }).snapshot;
          if (snapshot) termRef.current?.setSnapshot(snapshot);
          return;
        }
        case "exit": {
          const code = (f as { code?: number | null }).code ?? null;
          setExitCode(code);
          if (code === 0) {
            setState("success");
            onAuthenticatedRef.current?.(agent);
          } else {
            setState("failed");
          }
          return;
        }
        case "error": {
          const message = (f as { message?: string }).message;
          setErrorMessage(message ?? "Terminal backend error");
          setState("error");
          return;
        }
      }
    };

    socket.onerror = () => {
      setState((prev) => (prev === "success" ? prev : "error"));
      setErrorMessage((prev) => prev ?? "Login connection failed");
    };

    return () => {
      teardown();
    };
  }, [open, agent, attempt, teardown]);

  const handleRetry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  const executorLabel = agent ? EXECUTOR_LABELS[agent] : "";
  const showSpinner = state === "connecting";
  const banner =
    state === "success"
      ? { tone: "success" as const, text: t("authLoginDialogSuccess") }
      : state === "failed"
        ? {
            tone: "warn" as const,
            text: t("authLoginDialogFailed", {
              code: exitCode === null ? "?" : String(exitCode),
            }),
          }
        : state === "error"
          ? {
              tone: "warn" as const,
              text: t("authLoginDialogError", {
                message: errorMessage ?? "",
              }),
            }
          : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border border-border/60 bg-custom-background-100 text-foreground">
        <DialogHeader>
          <DialogTitle className="font-workspace text-[18px]">
            {t("authLoginDialogTitle", { executor: executorLabel })}
          </DialogTitle>
          <DialogDescription className="font-workspace text-[13px] leading-6 text-muted-foreground">
            {t("authLoginDialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {banner ? (
          <div
            className={`flex items-start gap-2 rounded-md border p-3 font-workspace text-[12px] leading-5 ${
              banner.tone === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
            }`}
          >
            {banner.tone === "success" ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>{banner.text}</span>
          </div>
        ) : null}

        <div className="relative h-[420px] w-full overflow-hidden rounded-md border border-border/60 bg-[#0a0a0a] p-2">
          <div ref={containerRef} className="h-full w-full" />
          {showSpinner ? (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-[12px] text-white/70">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t("authLoginDialogConnecting")}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {state === "failed" || state === "error" ? (
            <Button
              variant="outline"
              className="font-workspace"
              onClick={handleRetry}
            >
              {t("authLoginDialogRetry")}
            </Button>
          ) : null}
          <Button
            className="font-workspace"
            variant={state === "success" ? "default" : "outline"}
            onClick={() => onOpenChange(false)}
          >
            {t("authLoginDialogClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
