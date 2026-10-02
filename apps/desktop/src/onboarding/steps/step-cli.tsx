import {
  CHRO_CLI_NPM_INSTALL_COMMAND,
  cliInstallRegistersOnContinue,
} from "@/lib/cli-install-client";
import { ChroCliInstallControl } from "@/settings/components/chro-cli-install-control";
import type { useCliInstall } from "@/settings/hooks/use-cli-install";
import { Terminal } from "lucide-react";

const EXAMPLE_COMMANDS = [
  'chro task create "Add auth middleware" --prompt "Implement JWT auth"',
  "chro task logs <task>",
  "chro task merge <task>",
];

/**
 * Onboarding step 2: register the `chro` shell command. The desktop bundle
 * ships the CLI, so this is a symlink (or PATH entry on Windows). When that
 * needs no administrator prompt, Continue performs it (the flow owns the hook
 * for that); when it would prompt, the explicit button stays so the prompt is
 * the user's own click. The web build has no bundle and points at the npm
 * package instead. Skippable: the same control lives in Settings and the
 * title-bar CLI menu.
 */
export function StepCli({ cli }: { cli: ReturnType<typeof useCliInstall> }) {
  const registersOnContinue =
    cli.status !== null && cliInstallRegistersOnContinue(cli.status);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-custom-border-200 bg-custom-background-90 p-4">
        <div className="flex items-start gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-custom-background-80">
            <Terminal className="size-5 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm font-medium text-foreground">
              <span className="font-mono">chro</span> shell command
            </p>
            {cli.available ? (
              <ChroCliInstallControl
                cli={cli}
                hidePrimaryAction={registersOnContinue}
              />
            ) : (
              <code className="block rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] text-foreground/90">
                {CHRO_CLI_NPM_INSTALL_COMMAND}
              </code>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-1.5 rounded-lg bg-custom-background-90/60 px-4 py-3 font-mono text-[11px] text-muted-foreground">
        {EXAMPLE_COMMANDS.map((command) => (
          <p key={command} className="truncate">
            <span className="mr-1.5 text-muted-foreground/60">$</span>
            {command}
          </p>
        ))}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        {registersOnContinue
          ? "Continue registers the command. Skip leaves your shell untouched."
          : "Agents running inside Chro already have the command on their PATH; this step is for your own terminal."}
      </p>
    </div>
  );
}
