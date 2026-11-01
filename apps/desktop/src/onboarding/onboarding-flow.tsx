import {
  type BaseCodingAgent,
  updateExecutorProfile,
} from "@/lib/executor-client";
import { getRecentWorkspaces } from "@/lib/workspace-history";
import {
  cliInstallPrimaryAction,
  cliInstallRegistersOnContinue,
} from "@/lib/cli-install-client";
import { setUiValue } from "@/lib/ui-state-client";
import { useAgentSkill } from "@/settings/hooks/use-agent-skill";
import { useCliInstall } from "@/settings/hooks/use-cli-install";
import { Button } from "@chro/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@chro/ui/dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type OnboardingStep,
  ONBOARDING_STEP_ORDER,
  nextOnboardingStep,
  onboardingProgress,
  previousOnboardingStep,
} from "./step-order";
import { StepAgent } from "./steps/step-agent";
import { type CapabilitySelection, capabilityActions } from "./capability-setup";
import { StepCapabilities } from "./steps/step-capabilities";
import { StepTheme } from "./steps/step-theme";
import { StepWelcome } from "./steps/step-welcome";
import { StepWorkspace } from "./steps/step-workspace";
import { useAutoOpenOnboarding, useOnboardingStore } from "./use-onboarding";

const EXECUTOR_STORAGE_KEY = "chro:selected-executor";

const STEP_COPY: Record<
  Exclude<OnboardingStep, "welcome">,
  { title: string; subtitle: string }
> = {
  agent: {
    title: "Pick your coding agent",
    subtitle:
      "Chro detects the CLI agents already on your machine. Choose a default — you can install any that are missing and switch any time.",
  },
  capabilities: {
    title: "Set up your agents",
    subtitle:
      "Choose what to set up so agents can hand work to each other through Chro, and so you can drive Chro from your own terminal.",
  },
  theme: {
    title: "Make it feel like home",
    subtitle: "Pick the look you'll stare at for hours. Changes preview instantly.",
  },
  workspace: {
    title: "Open your first project",
    subtitle: "Point Chro at a local repo. This is where your agents will work.",
  },
};

/**
 * First-launch onboarding. A multi-step flow whose sequence is derived entirely
 * from ONBOARDING_STEP_ORDER (welcome is the intro, excluded from progress). The
 * current step is deliberately not persisted — only the completion flag is — so
 * the flow always starts at welcome and a returning user is skipped by the
 * completion gate in `useAutoOpenOnboarding`.
 */
export function OnboardingFlow() {
  const isOpen = useOnboardingStore((s) => s.isOpen);
  const complete = useOnboardingStore((s) => s.complete);
  useAutoOpenOnboarding();

  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [selectedExecutor, setSelectedExecutor] =
    useState<BaseCodingAgent | null>(null);
  const [persisting, setPersisting] = useState(false);
  const cli = useCliInstall(isOpen);
  const skill = useAgentSkill(isOpen);
  const [capabilities, setCapabilities] = useState<CapabilitySelection>({
    command: true,
    skill: true,
  });
  const commandRegistersOnContinue =
    cli.status !== null && cliInstallRegistersOnContinue(cli.status);
  const setupOnContinue =
    step === "capabilities"
      ? capabilityActions(capabilities, {
          commandRegistersOnContinue,
          skillState: skill.state,
        })
      : [];

  const canSkipWelcome = useMemo(() => getRecentWorkspaces().length > 0, []);

  const progress = onboardingProgress(step);

  // Persist the chosen executor when leaving the agent step, apply what is
  // switched on when leaving the capabilities step, then advance. A failure
  // keeps the step open with its error so the user can retry or Skip; it is
  // never swallowed by moving on.
  const advance = useCallback(async () => {
    if (persisting || cli.busy || skill.busy) return;
    for (const action of setupOnContinue) {
      if (action === "register_command") {
        const result = await cli.install();
        if (!result || cliInstallPrimaryAction(result) !== null) return;
      } else if ((await skill.install()) !== "installed") {
        return;
      }
    }
    if (step === "agent" && selectedExecutor) {
      setPersisting(true);
      try {
        await updateExecutorProfile({ executor: selectedExecutor, variant: null });
        setUiValue(EXECUTOR_STORAGE_KEY, selectedExecutor);
      } catch (err) {
        console.error("[onboarding] Failed to set executor", err);
      } finally {
        setPersisting(false);
      }
    }
    const next = nextOnboardingStep(step);
    if (next) setStep(next);
  }, [cli, persisting, selectedExecutor, setupOnContinue, skill, step]);

  const back = useCallback(() => {
    const prev = previousOnboardingStep(step);
    if (prev) setStep(prev);
  }, [step]);

  // Continue is gated per step: the agent step needs a selection (signing in is
  // not required); other steps are always advanceable.
  const canContinue = step === "agent" ? selectedExecutor !== null : true;

  // Cmd/Ctrl+Enter advances; Escape skips. Screen-local, not app commands.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key === "Enter" && (event.metaKey || event.ctrlKey)) &&
        step !== "welcome" &&
        step !== "workspace" &&
        canContinue
      ) {
        event.preventDefault();
        void advance();
      } else if (event.key === "Escape") {
        event.preventDefault();
        complete();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [advance, canContinue, complete, isOpen, step]);

  if (!isOpen) return null;

  if (step === "welcome") {
    return (
      <Dialog open onOpenChange={(next) => !next && complete()}>
        <DialogContent className="max-w-lg border-custom-border-200 bg-custom-background-100 p-0 text-foreground">
          <div className="flex min-h-[420px] flex-col p-8">
            <StepWelcome
              onNext={() => setStep(ONBOARDING_STEP_ORDER[0])}
              onSkip={canSkipWelcome ? complete : undefined}
            />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const copy = STEP_COPY[step];
  const isFinal = step === "workspace";

  return (
    <Dialog open onOpenChange={(next) => !next && complete()}>
      <DialogContent className="flex max-w-lg flex-col gap-0 border-custom-border-200 bg-custom-background-100 p-0 text-foreground">
        <DialogHeader className="space-y-4 p-6 pb-0">
          {/* Progress: one bar per persisted step; welcome shows none. */}
          <div className="flex items-center gap-1.5">
            {progress
              ? ONBOARDING_STEP_ORDER.map((s, i) => (
                  <span
                    key={s}
                    className={`h-1 rounded-full transition-all ${
                      i === progress.index
                        ? "w-8 bg-foreground"
                        : i < progress.index
                          ? "w-5 bg-muted-foreground/70"
                          : "w-5 bg-muted-foreground/25"
                    }`}
                  />
                ))
              : null}
            {progress ? (
              <span className="ml-2 text-xs font-medium text-muted-foreground">
                {progress.index + 1} of {progress.total}
              </span>
            ) : null}
          </div>
          <div>
            <DialogTitle className="text-xl font-semibold tracking-tight">
              {copy.title}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[13px] leading-relaxed">
              {copy.subtitle}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="max-h-[52vh] overflow-y-auto px-6 py-5">
          {step === "agent" && (
            <StepAgent
              selectedExecutor={selectedExecutor}
              onSelect={setSelectedExecutor}
            />
          )}
          {step === "capabilities" && (
            <StepCapabilities
              cli={cli}
              skill={skill}
              selection={capabilities}
              onSelectionChange={setCapabilities}
              commandRegistersOnContinue={commandRegistersOnContinue}
            />
          )}
          {step === "theme" && <StepTheme />}
          {step === "workspace" && <StepWorkspace onOpened={complete} />}
        </div>

        <div className="flex items-center justify-between border-t border-custom-border-200 p-4">
          <div className="flex gap-1">
            <Button variant="ghost" onClick={back}>
              Back
            </Button>
            {!isFinal ? (
              <Button variant="ghost" onClick={complete}>
                Skip
              </Button>
            ) : null}
          </div>
          {!isFinal ? (
            <Button
              disabled={!canContinue || persisting || cli.busy || skill.busy}
              onClick={() => void advance()}
            >
              {setupOnContinue.length > 0 ? "Set up and continue" : "Continue"}
            </Button>
          ) : (
            <span className="pr-2 text-xs text-muted-foreground">
              Open a project to finish
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
