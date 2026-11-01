import type { AgentSkillState } from "@/lib/agent-skill-client";

/** The capabilities the onboarding step offers, each a checkbox. */
export interface CapabilitySelection {
  /** Register `chro` as a command in the person's own terminal. */
  command: boolean;
  /** Install the agent skill so agents know to use chro. */
  skill: boolean;
}

export type CapabilityAction = "register_command" | "install_skill";

/**
 * What Continue does: only what is checked and not already done. A conflict
 * is reported, never forced past, and nothing is written when the state is
 * unknown.
 */
export function capabilityActions(
  selection: CapabilitySelection,
  facts: { commandRegistersOnContinue: boolean; skillState: AgentSkillState },
): CapabilityAction[] {
  const actions: CapabilityAction[] = [];
  if (selection.command && facts.commandRegistersOnContinue) {
    actions.push("register_command");
  }
  if (
    selection.skill &&
    (facts.skillState === "not_installed" || facts.skillState === "outdated")
  ) {
    actions.push("install_skill");
  }
  return actions;
}
