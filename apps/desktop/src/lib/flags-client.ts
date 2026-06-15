import { desktopFetch } from "./backend-client";

// Matches Status in crates/analytics/src/flags.rs
export type FlagStatus =
  | "experimental"
  | "rolling_out"
  | "graduated"
  | "killed";

// Matches the flag keys in crates/analytics/src/flags.rs.
// The backend registry is the source of truth; this union exists for
// autocomplete and compile-time safety when gating code on a flag.
export type FlagKey =
  | "inline_diff_v2"
  | "terminal_canvas_renderer"
  | "ask_user_question_ui";

// Matches FlagView in crates/server/src/routes/rpc/flags.rs
export interface FlagView {
  key: string;
  owner: string;
  created: string;
  retire_by: string;
  default_enabled: boolean;
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
