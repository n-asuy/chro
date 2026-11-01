import { LanguageProvider } from "@/i18n";
import type {
  AgentSkillState,
  SkillInstallReport,
} from "@/lib/agent-skill-client";
import type { useAgentSkill } from "@/settings/hooks/use-agent-skill";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentSkillInstallControl } from "../agent-skill-install-control";

type AgentSkill = ReturnType<typeof useAgentSkill>;

const report: SkillInstallReport = {
  skill: "/home/u/.agents/skills/chro",
  dry_run: true,
  targets: [
    {
      harness: "agents",
      path: "/home/u/.agents/skills/chro",
      outcome: "unchanged",
    },
    {
      harness: "claude",
      path: "/home/u/.claude/skills/chro",
      outcome: "conflict",
      detail: "a folder you made is in the way",
    },
  ],
};

function render(
  state: AgentSkillState,
  overrides: Partial<AgentSkill> = {},
  props: { hideInstall?: boolean } = {},
): string {
  const skill: AgentSkill = {
    available: true,
    report,
    state,
    loading: false,
    busy: false,
    error: null,
    reload: async () => {},
    install: async () => null,
    ...overrides,
  };
  return renderToStaticMarkup(
    <LanguageProvider>
      <AgentSkillInstallControl skill={skill} {...props} />
    </LanguageProvider>,
  );
}

describe("AgentSkillInstallControl", () => {
  it("offers to install when the skill is missing", () => {
    const html = render("not_installed");
    expect(html).toContain("Not installed");
    expect(html).toContain(">Install<");
  });

  it("offers an update when it is outdated", () => {
    expect(render("outdated")).toContain(">Update<");
  });

  it("has no action once installed", () => {
    const html = render("installed");
    expect(html).toContain("Installed");
    expect(html).not.toContain("<button");
  });

  it("names what is in the way on a conflict and does not offer to overwrite it", () => {
    const html = render("conflict");
    expect(html).toContain("/home/u/.claude/skills/chro");
    expect(html).not.toContain(">Install<");
  });

  it("leaves the action to the host when it installs on Continue", () => {
    expect(render("not_installed", {}, { hideInstall: true })).not.toContain(
      ">Install<",
    );
  });

  it("shows the command to run where the app cannot install it", () => {
    const html = render("unavailable", { available: false, report: null });
    expect(html).toContain("chro skill install");
  });
});
