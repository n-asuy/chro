/**
 * The `chro` agent skill: an entry point placed in each agent harness's skill
 * folder that tells agents when to use chro and to load the guide with
 * `chro skill show`. The desktop shell runs the bundled CLI's
 * `chro skill install` (`agent_skill_status` is its dry run). The web build
 * has no bundled CLI, so the API is absent there and callers show the command
 * instead.
 *
 * Mirrors `InstallReport` in crates/server/src/cli/skill.rs.
 */
export type SkillOutcome =
  | "installed"
  | "updated"
  | "unchanged"
  | "conflict"
  | "skipped";

export interface SkillTargetReport {
  /** `agents` for the shared copy, then one entry per harness. */
  harness: string;
  path: string;
  outcome: SkillOutcome;
  detail?: string;
}

export interface SkillInstallReport {
  skill: string;
  dry_run: boolean;
  targets: SkillTargetReport[];
}

export interface AgentSkillApi {
  status: () => Promise<SkillInstallReport>;
  install: () => Promise<SkillInstallReport>;
}

export const getAgentSkillApi = (): AgentSkillApi | undefined =>
  typeof window === "undefined" ? undefined : window.desktop?.skill;

/** What a person runs by hand where the app cannot install the skill. */
export const CHRO_SKILL_INSTALL_COMMAND = "chro skill install";

export type AgentSkillState =
  | "installed"
  | "not_installed"
  | "outdated"
  | "conflict"
  /** No supported agent (Claude Code, Codex) is installed to read it. */
  | "no_agent"
  /** Not probed yet, or the probe failed. */
  | "unavailable";

/**
 * One state from a dry-run report, so every surface (onboarding, the Agent
 * status menu) words the same report the same way.
 */
export function agentSkillState(
  report: SkillInstallReport | null,
): AgentSkillState {
  if (!report || report.targets.length === 0) return "unavailable";
  const [shared, ...harnesses] = report.targets;
  const present = harnesses.filter((t) => t.outcome !== "skipped");
  if (report.targets.some((t) => t.outcome === "conflict")) return "conflict";
  if (present.length === 0) return "no_agent";
  if (shared?.outcome === "installed") return "not_installed";
  if (
    report.targets.every(
      (t) => t.outcome === "unchanged" || t.outcome === "skipped",
    )
  ) {
    return "installed";
  }
  return "outdated";
}
