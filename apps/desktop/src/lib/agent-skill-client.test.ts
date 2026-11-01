import { describe, expect, it } from "vitest";
import {
  type SkillInstallReport,
  type SkillOutcome,
  agentSkillState,
} from "./agent-skill-client";

/** A dry-run report: the canonical copy first, then one link per harness. */
const report = (
  agents: SkillOutcome,
  claude: SkillOutcome,
  codex: SkillOutcome = "skipped",
): SkillInstallReport => ({
  skill: "/home/u/.agents/skills/chro",
  dry_run: true,
  targets: [
    { harness: "agents", path: "/home/u/.agents/skills/chro", outcome: agents },
    { harness: "claude", path: "/home/u/.claude/skills/chro", outcome: claude },
    { harness: "codex", path: "/home/u/.codex/skills/chro", outcome: codex },
  ],
});

describe("agentSkillState", () => {
  it("is installed when every present harness is already linked to the current copy", () => {
    expect(agentSkillState(report("unchanged", "unchanged"))).toBe("installed");
  });

  it("is not installed when the copy would be written for the first time", () => {
    expect(agentSkillState(report("installed", "installed"))).toBe(
      "not_installed",
    );
  });

  it("needs an update when the copy is older or a harness is not linked yet", () => {
    expect(agentSkillState(report("updated", "unchanged"))).toBe("outdated");
    expect(agentSkillState(report("unchanged", "unchanged", "installed"))).toBe(
      "outdated",
    );
  });

  it("reports a conflict when something else occupies a location", () => {
    expect(agentSkillState(report("unchanged", "conflict"))).toBe("conflict");
  });

  it("has nothing to install into without a supported agent", () => {
    expect(agentSkillState(report("installed", "skipped", "skipped"))).toBe(
      "no_agent",
    );
  });
});
