/**
 * Registration of the bundled `chro` shell command, exposed by the desktop
 * shell (`cli_install_status` / `cli_install` / `cli_remove`). The web build has
 * no bundle to register, so the API is absent there and callers fall back to
 * the npm distribution.
 *
 * Mirrors `CliInstallStatus` in apps/desktop/src-tauri/src/runtime/cli_install.rs.
 */
export type CliInstallState =
  | "not_installed"
  | "installed"
  | "stale"
  | "conflict"
  | "unsupported";

export interface CliInstallStatus {
  platform: string;
  commandName: string;
  commandPath: string | null;
  pathDirectory: string | null;
  /** Whether a freshly opened terminal will find the command. */
  pathConfigured: boolean;
  /** Registering would trigger an administrator prompt. */
  needsElevation: boolean;
  launcherPath: string | null;
  installMethod: "symlink" | "path_entry" | null;
  supported: boolean;
  state: CliInstallState;
  currentTarget: string | null;
  detail: string | null;
}

export interface CliInstallApi {
  status: () => Promise<CliInstallStatus>;
  install: () => Promise<CliInstallStatus>;
  remove: () => Promise<CliInstallStatus>;
}

export const getCliInstallApi = (): CliInstallApi | undefined =>
  typeof window === "undefined" ? undefined : window.desktop?.cli;

/** The one-line install path for builds without a bundle to register. */
export const CHRO_CLI_NPM_INSTALL_COMMAND = "npm install -g @chro-ai/cli";

/**
 * What the user has to do next, collapsed from the raw status. Every surface
 * (title-bar menu, Settings, onboarding) derives its copy and buttons from
 * this so they cannot disagree about the state of the same symlink.
 */
export type CliInstallAttention =
  | "ready"
  | "needs_install"
  | "needs_repair"
  | "needs_path"
  | "blocked"
  | "unsupported";

export function cliInstallAttention(
  status: CliInstallStatus,
): CliInstallAttention {
  if (!status.supported) return "unsupported";
  switch (status.state) {
    case "installed":
      return status.pathConfigured ? "ready" : "needs_path";
    case "not_installed":
      return "needs_install";
    case "stale":
      return "needs_repair";
    case "conflict":
      return "blocked";
    case "unsupported":
      return "unsupported";
  }
}

/** Whether the state deserves an indicator before the user opens anything. */
export function cliInstallNeedsAttention(status: CliInstallStatus): boolean {
  const attention = cliInstallAttention(status);
  return attention !== "ready" && attention !== "unsupported";
}

/**
 * Which registration action the primary button performs, if any. `remove` is
 * offered separately whenever a chro-owned command exists.
 */
export function cliInstallPrimaryAction(
  status: CliInstallStatus,
): "install" | "repair" | null {
  switch (cliInstallAttention(status)) {
    case "needs_install":
      return "install";
    case "needs_repair":
      return "repair";
    default:
      return null;
  }
}

export function cliInstallCanRemove(status: CliInstallStatus): boolean {
  return (
    status.supported && (status.state === "installed" || status.state === "stale")
  );
}

/**
 * Whether onboarding may register the command as a side effect of Continue.
 * Only when there is something to do and doing it is silent: an administrator
 * prompt must come from an explicit click, not from advancing a wizard.
 */
export function cliInstallRegistersOnContinue(status: CliInstallStatus): boolean {
  return cliInstallPrimaryAction(status) !== null && !status.needsElevation;
}
