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
}

interface SkillsEnvelope {
  skills: SkillSummary[];
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
