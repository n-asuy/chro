import { desktopFetch } from "./backend-client";

// Matches FlagView in crates/server/src/routes/rpc/flags.rs. The registry's
// operating metadata (owner, status, rollout owner, retire-by) deliberately
// does not cross this boundary.
export interface FlagView {
  key: string;
  /** Whether this installation has the flag, before any local opt-out. */
  enabled: boolean;
}

interface FlagRegistryResponse {
  flags: FlagView[];
}

export const fetchFlagRegistry = async (): Promise<FlagView[]> => {
  const res = await desktopFetch<FlagRegistryResponse>("/rpc/flags/registry");
  return res.flags;
};
