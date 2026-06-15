import { desktopFetch } from "@/lib/backend-client";

export type SkillSource =
  | "workspace_claude"
  | "workspace_agents"
  | "workspace_chro"
  | "user_claude"
  | "user_agents"
  | "user_codex";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  source_label: string;
  source_path: string;
  base_dir: string;
  /** Absolute path to the skill package directory, for opening on disk. */
  abs_dir: string;
}

interface SkillsEnvelope {
  skills: SkillSummary[];
}

/** Whether a skill lives in the workspace or the user's home. */
export type SkillScope = "workspace" | "user";

/**
 * The agent ecosystem a skill targets. Only the three real ecosystems exist:
 * Claude (`.claude/skills`), Codex (`.codex/skills`), and the cross-agent
 * Agent Skills convention (`.agents/skills`). The bare `<workspace>/skills`
 * directory is provider-agnostic, so it folds into Agent Skills.
 */
export type SkillProvider = "claude" | "codex" | "agents";

/** Whether a skill is scoped to the current workspace or the user's home. */
export function skillScope(skill: SkillSummary): SkillScope {
  return skill.source.startsWith("workspace_") ? "workspace" : "user";
}

/** The agent ecosystem a skill targets, collapsed from the 6 source kinds. */
export function skillProvider(skill: SkillSummary): SkillProvider {
  switch (skill.source) {
    case "workspace_claude":
    case "user_claude":
      return "claude";
    case "user_codex":
      return "codex";
    case "workspace_agents":
    case "user_agents":
    case "workspace_chro":
      return "agents";
  }
}

/** Short, human-readable label for where a skill is defined. */
export function skillSourceLabel(skill: SkillSummary): string {
  switch (skill.source) {
    case "workspace_claude":
      return ".claude";
    case "workspace_agents":
      return ".agents";
    case "workspace_chro":
      return "workspace";
    case "user_claude":
      return "~/.claude";
    case "user_agents":
      return "~/.agents";
    case "user_codex":
      return "~/.codex";
  }
}

export async function listSkills(
  workspacePath?: string | null,
): Promise<SkillSummary[]> {
  const params = new URLSearchParams();
  if (workspacePath?.trim()) {
    params.set("workspace_path", workspacePath.trim());
  }
  const query = params.toString();
  const response = await desktopFetch<SkillsEnvelope>(
    query ? `/rpc/skills?${query}` : "/rpc/skills",
  );
  return response.skills;
}
