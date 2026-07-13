import { desktopFetch } from "./backend-client";

/** Mirrors `CliStatus` in crates/executors/src/cli_status.rs. */
export interface CliStatus {
  name: string;
  found: boolean;
  path: string | null;
  source: string | null;
  version: string | null;
  install_hint: string;
}

/** Mirrors `CliStatusResponse` in crates/server/src/routes/rpc/cli_status.rs. */
export interface CliStatusResponse {
  agents: CliStatus[];
  chro_cli: CliStatus;
  server_version: string;
  latest_release: string | null;
  update_available: boolean;
}

export function fetchCliStatus(): Promise<CliStatusResponse> {
  return desktopFetch<CliStatusResponse>("/rpc/cli-status");
}
