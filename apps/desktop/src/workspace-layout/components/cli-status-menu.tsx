import { cn } from "@/lib/cn";
import { type ProviderUsage, fetchAgentUsage } from "@/lib/agent-usage-client";
import {
  CHRO_CLI_NPM_INSTALL_COMMAND,
  cliInstallNeedsAttention,
} from "@/lib/cli-install-client";
import {
  type CliStatus,
  type CliStatusResponse,
  fetchCliStatus,
} from "@/lib/cli-status-client";
import { ChroCliInstallControl } from "@/settings/components/chro-cli-install-control";
import { useCliInstall } from "@/settings/hooks/use-cli-install";
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
 * Surfaces the resolved path + reported version of each agent CLI, the latest
 * published chro release, and whether chro's own shell command is registered.
 * The command is a link to this app's bundled CLI, so "registered" already
 * implies "same version as the app"; the badge flags a missing, stale, or
 * unreachable registration and a server behind the latest release.
 */
export function CliStatusMenu() {
  const [status, setStatus] = useState<CliStatusResponse | null>(null);
  const cli = useCliInstall();
  const [usageByProvider, setUsageByProvider] = useState<
    Record<string, ProviderUsage>
  >({});
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

  // Usage windows come from a slower network fetch, so they load independently
  // of the fast CLI probe and never block the menu from rendering. The backend
  // caches the result, so re-opening the menu is cheap.
  const loadUsage = useCallback(async () => {
    try {
      const res = await fetchAgentUsage();
      setUsageByProvider(
        Object.fromEntries(res.providers.map((p) => [p.provider, p])),
      );
    } catch {
      // Usage is auxiliary; a failure leaves the rows in their plain state.
    }
  }, []);

  // Fetch once when the menu is first opened, then on explicit refresh only.
  useEffect(() => {
    if (open && status === null && !loading) {
      void load();
      void loadUsage();
    }
  }, [open, status, loading, load, loadUsage]);

  const driftWarning =
    (status?.update_available ?? false) ||
    (cli.status !== null && cliInstallNeedsAttention(cli.status));

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
              void loadUsage();
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
            <ChroRow status={status} cli={cli} />
            <DropdownMenuSeparator />
            {status.agents.map((agent) => {
              const meta = agentMeta(agent.name);
              return (
                <CliRow
                  key={agent.name}
                  label={meta.label}
                  homepage={meta.homepage}
                  status={agent}
                  usage={usageByProvider[agent.name]}
                />
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChroRow({
  status,
  cli,
}: {
  status: CliStatusResponse;
  cli: ReturnType<typeof useCliInstall>;
}) {
  const { server_version, latest_release, update_available } = status;
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
      <div className="mt-1 space-y-1 pl-5 text-[11px] text-muted-foreground">
        <MetaLine label="latest" value={latest_release ?? "unknown"} />
        {cli.available ? (
          <ChroCliInstallControl cli={cli} compact />
        ) : (
          <>
            <p>Install the chro CLI to drive tasks from your terminal:</p>
            <CommandSnippet command={CHRO_CLI_NPM_INSTALL_COMMAND} />
          </>
        )}
      </div>
    </div>
  );
}

function CliRow({
  label,
  homepage,
  status,
  usage,
}: {
  label: string;
  homepage: string | null;
  status: CliStatus;
  usage?: ProviderUsage;
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
      {status.found ? <UsageMeter usage={usage} /> : null}
    </div>
  );
}

/**
 * Rolling-window token usage for an agent CLI, read from its local session
 * logs. Hidden when the CLI keeps no logs, or when it simply has not been used
 * in the window — an all-zero row is noise next to the CLIs that were.
 *
 * There is deliberately no "% of limit" bar: the logs carry what was consumed,
 * not the plan ceiling, so a filled bar would need a denominator we do not
 * have. The bar here shows composition (fresh vs cached prompt tokens), which
 * the data does support.
 */
function UsageMeter({ usage }: { usage?: ProviderUsage }) {
  if (!usage || usage.status !== "ok" || usage.tokens.total === 0) {
    return null;
  }
  const { tokens } = usage;
  const cachedPct = Math.round((tokens.cache_read / tokens.total) * 100);

  return (
    <div className="mt-1.5 space-y-1 pl-5">
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-[10px] text-muted-foreground">
          {usageWindowLabel(usage.window_minutes)}
        </span>
        <span className="flex h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full bg-emerald-500"
            style={{ width: `${100 - cachedPct}%` }}
          />
          <span
            className="block h-full bg-foreground/25"
            style={{ width: `${cachedPct}%` }}
          />
        </span>
        <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-foreground/80">
          {formatTokens(tokens.total)}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground/70">
        {formatTokens(tokens.output)} out · {cachedPct}% cached ·{" "}
        {usage.session_count} session{usage.session_count === 1 ? "" : "s"}
        {usage.cost_usd != null ? ` · ${formatCost(usage.cost_usd)}` : ""}
      </p>
    </div>
  );
}

function usageWindowLabel(windowMinutes: number): string {
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`;
  }
  return `${windowMinutes}m`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000_000) {
    return `${(count / 1_000_000_000).toFixed(1)}B`;
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return `${count}`;
}

function formatCost(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
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
