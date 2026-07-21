import { desktopFetch } from "./backend-client";

/** Mirrors `UsageStatus` in crates/server/src/routes/rpc/usage.rs. */
export type UsageStatus = "ok" | "unavailable";

/** Mirrors `TokenTotals` in crates/server/src/routes/rpc/usage.rs. */
export interface TokenTotals {
  /** Fresh (non-cached) prompt tokens. */
  input: number;
  output: number;
  /** Prompt tokens served from cache. */
  cache_read: number;
  /** Prompt tokens written into the cache. */
  cache_creation: number;
  total: number;
}

/** Mirrors `ProviderUsage` in crates/server/src/routes/rpc/usage.rs. */
export interface ProviderUsage {
  /** Matches the `cli-status` manifest name (e.g. `claude`). */
  provider: string;
  status: UsageStatus;
  /** Length of the rolling window these totals cover. */
  window_minutes: number;
  tokens: TokenTotals;
  /** Only present for CLIs that record spend themselves. */
  cost_usd: number | null;
  session_count: number;
  updated_at_ms: number;
}

/** Mirrors `AgentUsageResponse` in crates/server/src/routes/rpc/usage.rs. */
export interface AgentUsageResponse {
  providers: ProviderUsage[];
}

export function fetchAgentUsage(): Promise<AgentUsageResponse> {
  return desktopFetch<AgentUsageResponse>("/rpc/agent-usage");
}
