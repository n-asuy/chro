import { cn } from "@/lib/cn";
import {
  type CliStatus,
  type CliStatusResponse,
  fetchCliStatus,
} from "@/lib/cli-status-client";
import type { BaseCodingAgent } from "@/lib/executor-client";
import { EXECUTOR_INSTALL_GUIDE_URLS } from "@/lib/executor-install";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RotateCcw,
  Terminal,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * chro's own CLI ships on npm as `@chro-ai/cli` (bin `chro`). Installing it
 * globally fetches the `latest` dist-tag — the update path for the version
 * drift this menu surfaces. (It installs into npm's global prefix; if a stale
 * `chro` sits earlier on PATH, that entry must be removed separately.)
 */
const CHRO_CLI_INSTALL_COMMAND = "npm install -g @chro-ai/cli";
/** Human-facing releases page (backend polls the same repo's latest tag). */
const CHRO_RELEASES_URL = "https://github.com/n-asuy/chro/releases";

/**
 * Display label + upstream install-guide link for each agent CLI, keyed by the
 * manifest name reported by `/rpc/cli-status`. The links reuse the single
 * source of truth in `executor-install`, so this surface and the install dialog
 * can never point users at diverging URLs.
 */
const AGENT_META: Record<string, { label: string; executor: BaseCodingAgent }> =
  {
    claude: { label: "Claude Code", executor: "CLAUDE_CODE" },
    codex: { label: "Codex", executor: "CODEX" },
    pi: { label: "pi", executor: "PI" },
  };

function agentMeta(name: string): { label: string; homepage: string | null } {
  const meta = AGENT_META[name];
  if (!meta) {
    return { label: name, homepage: null };
  }
  return { label: meta.label, homepage: EXECUTOR_INSTALL_GUIDE_URLS[meta.executor] };
}

/**
 * Title-bar CLI status menu (right of the traffic-light region, near Settings).
 * Surfaces the resolved path + reported version of each agent CLI and of chro's
 * own CLI, plus the latest published chro release. The chro-CLI-vs-latest drift
 * warning is the point: a stale binary shadowing the intended one on PATH
 * silently breaks CLI-resolved features, so it is made visible here.
 */
export function CliStatusMenu() {
  const [status, setStatus] = useState<CliStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await fetchCliStatus());
    } catch {
      // A status probe failure must never clutter the chrome; leave prior data.
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch once when the menu is first opened, then on explicit refresh only.
  useEffect(() => {
    if (open && status === null && !loading) {
      void load();
    }
  }, [open, status, loading, load]);

  const driftWarning = status?.update_available ?? false;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="CLI status"
                className={cn(
                  "relative ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                  "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                )}
              >
                <Terminal className="h-3.5 w-3.5" />
                {driftWarning ? (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
                ) : null}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center">
            CLI status
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-xs font-medium">
            CLI status
          </DropdownMenuLabel>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              void load();
            }}
            aria-label="Refresh"
            className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
          </button>
        </div>

        <DropdownMenuSeparator />

        {status === null ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {loading ? "Probing CLIs…" : "No data."}
          </div>
        ) : (
          <>
            <ChroRow status={status} />
            <DropdownMenuSeparator />
            {status.agents.map((agent) => {
              const meta = agentMeta(agent.name);
              return (
                <CliRow
                  key={agent.name}
                  label={meta.label}
                  homepage={meta.homepage}
                  status={agent}
                />
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChroRow({ status }: { status: CliStatusResponse }) {
  const { chro_cli, server_version, latest_release, update_available } = status;
  // Surface the install command whenever it is actionable: to update a drifted
  // CLI, or to install one that is missing from PATH entirely.
  const showInstall = update_available || !chro_cli.found;
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        {update_available ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        )}
        <span className="text-xs font-medium">chro</span>
        <ExternalLinkAffordance href={CHRO_RELEASES_URL} label="chro releases" />
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          server {server_version}
        </span>
      </div>
      <div className="mt-1 space-y-0.5 pl-5 text-[11px] text-muted-foreground">
        <MetaLine
          label="CLI"
          value={
            chro_cli.found
              ? (chro_cli.version ?? chro_cli.path ?? "found")
              : "not found on PATH"
          }
        />
        {chro_cli.path ? <MetaLine label="path" value={chro_cli.path} /> : null}
        <MetaLine label="latest" value={latest_release ?? "unknown"} />
        {!update_available && !chro_cli.found ? (
          <p>Install the chro CLI to drive tasks from your terminal:</p>
        ) : null}
        {showInstall ? (
          <CommandSnippet command={CHRO_CLI_INSTALL_COMMAND} />
        ) : null}
      </div>
    </div>
  );
}

function CliRow({
  label,
  homepage,
  status,
}: {
  label: string;
  homepage: string | null;
  status: CliStatus;
}) {
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        {status.found ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-medium">{label}</span>
        {homepage ? (
          <ExternalLinkAffordance href={homepage} label={`${label} install guide`} />
        ) : null}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {status.version ?? (status.found ? "version n/a" : "not found")}
        </span>
      </div>
      {status.found ? (
        <div className="mt-1 space-y-0.5 pl-5 text-[11px] text-muted-foreground">
          {status.path ? <MetaLine label="path" value={status.path} /> : null}
          {status.source ? (
            <MetaLine label="source" value={status.source} />
          ) : null}
        </div>
      ) : (
        <p className="mt-1 pl-5 text-[11px] text-muted-foreground">
          {status.install_hint}
        </p>
      )}
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="truncate">
      <span className="text-muted-foreground/70">{label}: </span>
      <span className="text-foreground/80">{value}</span>
    </p>
  );
}

/**
 * Small trailing icon-link. The app-wide `ExternalLinkHandler` intercepts the
 * click and routes it through the desktop shell, so a plain anchor is enough.
 */
function ExternalLinkAffordance({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground"
    >
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/** Monospace command with click-to-copy. Falls back to manual selection when
 *  the clipboard API is unavailable. */
function CommandSnippet({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; the command stays visible for manual copy.
    }
  }, [command]);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        void copy();
      }}
      title="Copy command"
      className="mt-1 flex w-full items-center gap-1.5 rounded border border-border/60 bg-muted/40 px-1.5 py-1 text-left font-mono text-[11px] text-foreground/90 hover:bg-muted"
    >
      <span className="truncate">{command}</span>
      {copied ? (
        <Check className="ml-auto h-3 w-3 shrink-0 text-emerald-500" />
      ) : (
        <Copy className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}
