import { type TranslationKey, useLanguage } from "@/i18n";
import { type ProviderUsage, fetchAgentUsage } from "@/lib/agent-usage-client";
import { useEffect, useState } from "react";
import { usePanelReady } from "./edge-panel-ready";

const PROVIDER_LABEL: Record<string, TranslationKey> = {
  claude: "mcpExecutorOptionClaude",
  codex: "mcpExecutorOptionCodex",
  pi: "mcpExecutorOptionPi",
};

function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

function windowLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/**
 * "…" → Usage, in the mock's usage panel shape: one block per agent with its
 * numbers. The data is chro's agent usage (`GET /rpc/agent-usage`, the same as
 * the CLI-status menu's meter): tokens in the agent's rolling window, read
 * from its local logs. The logs carry no plan ceiling, so there is no bar.
 */
export function EdgeUsagePanel() {
  const { t } = useLanguage();
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetchAgentUsage()
      .then((res) => {
        if (alive) setProviders(res.providers);
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  usePanelReady(providers !== null);

  const used = (providers ?? []).filter(
    (p) => p.status === "ok" && p.tokens.total > 0,
  );
  return (
    <section
      aria-label={t("edgeToolbarUsage")}
      className="edge-usage"
      data-edge-panel-content
    >
      {providers !== null && used.length === 0 ? (
        <p className="edge-usage-empty">{t("edgeToolbarUsageEmpty")}</p>
      ) : null}
      {used.map((p) => {
        const label = PROVIDER_LABEL[p.provider];
        return (
          <div key={p.provider} className="edge-usage-block">
            <div className="edge-usage-prov">
              {label ? t(label) : p.provider}
              <span>
                {t("edgeToolbarUsageWindow", {
                  window: windowLabel(p.window_minutes),
                })}
              </span>
            </div>
            <div className="edge-usage-meter">
              <div className="edge-usage-line">
                {t("edgeToolbarUsageTokens")}
                <span>
                  {formatTokens(p.tokens.total)} ·{" "}
                  {t("edgeToolbarUsageSessions", { count: p.session_count })}
                  {p.cost_usd != null ? ` · $${p.cost_usd.toFixed(2)}` : ""}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
