import { CHRO_CLI_NPM_INSTALL_COMMAND } from "@/lib/cli-install-client";
import { AgentSkillInstallControl } from "@/settings/components/agent-skill-install-control";
import { ChroCliInstallControl } from "@/settings/components/chro-cli-install-control";
import type { useAgentSkill } from "@/settings/hooks/use-agent-skill";
import type { useCliInstall } from "@/settings/hooks/use-cli-install";
import { Switch } from "@chro/ui/switch";
import { BookOpen, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import type { CapabilitySelection } from "../capability-setup";

/**
 * Onboarding step 2: choose what to set up for agents, each with its own
 * switch. Nothing is written until Continue, and only what is switched on is
 * applied (see `capabilityActions`). Both stay available afterwards in the
 * title-bar Agent status menu.
 *
 * - The agent skill goes into Claude Code's and Codex's skill folders, which
 *   every agent on the machine reads, so it is a choice, not a default action.
 * - The `chro` command is for the person's own terminal; agents that Chro
 *   starts already have it on their PATH.
 */
export function StepCapabilities({
  cli,
  skill,
  selection,
  onSelectionChange,
  commandRegistersOnContinue,
}: {
  cli: ReturnType<typeof useCliInstall>;
  skill: ReturnType<typeof useAgentSkill>;
  selection: CapabilitySelection;
  onSelectionChange: (next: CapabilitySelection) => void;
  commandRegistersOnContinue: boolean;
}) {
  const skillInstallsOnContinue =
    selection.skill &&
    (skill.state === "not_installed" || skill.state === "outdated");

  return (
    <div className="space-y-3">
      <CapabilityCard
        icon={<BookOpen className="size-5 text-muted-foreground" />}
        title="Teach agents to use chro"
        description={
          <>
            Adds a short skill to Claude Code and Codex. It tells them when to
            hand work to another session, wait for it, or answer its approvals,
            and to load the commands with <Mono>chro skill show</Mono>. Agents
            outside Chro can see it too.
          </>
        }
        checked={selection.skill}
        onCheckedChange={(checked) =>
          onSelectionChange({ ...selection, skill: checked })
        }
      >
        <AgentSkillInstallControl
          skill={skill}
          hideInstall={skillInstallsOnContinue}
        />
      </CapabilityCard>

      <CapabilityCard
        icon={<Terminal className="size-5 text-muted-foreground" />}
        title="Use chro from your terminal"
        description={
          <>
            Registers the <Mono>chro</Mono> command in your shell. It links to
            this app and updates with it. Agents started by Chro have it
            already.
          </>
        }
        checked={selection.command}
        onCheckedChange={(checked) =>
          onSelectionChange({ ...selection, command: checked })
        }
      >
        {cli.available ? (
          <ChroCliInstallControl
            cli={cli}
            hidePrimaryAction={selection.command && commandRegistersOnContinue}
          />
        ) : (
          <code className="block rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground/90">
            {CHRO_CLI_NPM_INSTALL_COMMAND}
          </code>
        )}
      </CapabilityCard>

      <p className="text-center text-xs text-muted-foreground">
        Only what is switched on is set up when you continue. You can change
        either later from Agent status in the title bar.
      </p>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[11px] text-foreground/80">{children}</code>
  );
}

function CapabilityCard({
  icon,
  title,
  description,
  checked,
  onCheckedChange,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-custom-border-200 bg-custom-background-90 p-4">
      <div className="flex items-start gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-custom-background-80">
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {description}
              </p>
            </div>
            <Switch
              checked={checked}
              onCheckedChange={onCheckedChange}
              aria-label={title}
            />
          </div>
          {checked ? children : null}
        </div>
      </div>
    </div>
  );
}
