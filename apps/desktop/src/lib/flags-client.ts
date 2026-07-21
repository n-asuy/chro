import { desktopFetch } from "./backend-client";

// Matches Status in crates/analytics/src/flags.rs
export type FlagStatus =
  | "experimental"
  | "rolling_out"
  | "graduated"
  | "killed";

// Matches Rollout in crates/analytics/src/flags.rs
// "local": the backend registry decides and PostHog is never consulted.
// "remote": PostHog decides, and default_enabled is only a fallback.
export type FlagRollout = "local" | "remote";

export type { FlagKey } from "./flags.generated";

// Matches FlagView in crates/server/src/routes/rpc/flags.rs
export interface FlagView {
  key: string;
  owner: string;
  created: string;
  retire_by: string;
  default_enabled: boolean;
  rollout: FlagRollout;
  status: FlagStatus;
  description: string;
  // Effective value before any local developer override is applied.
  resolved_value: boolean;
}

interface FlagRegistryResponse {
  flags: FlagView[];
}

export const fetchFlagRegistry = async (): Promise<FlagView[]> => {
  const res = await desktopFetch<FlagRegistryResponse>("/rpc/flags/registry");
  return res.flags;
};
