import { Button } from "@chro/ui/button";

/**
 * Onboarding welcome. A product intro, not a setup step: it shows no progress
 * indicator and is always the entry point. The "I've done this before" escape
 * is only offered when the user already has a recent workspace (otherwise
 * skipping would strand them with nothing to open).
 */
export function StepWelcome({
  onNext,
  onSkip,
}: {
  onNext: () => void;
  onSkip?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="mb-6 flex size-16 items-center justify-center rounded-2xl border border-custom-border-200 bg-custom-background-90">
        <img src="/logo_chro_symbol.png" alt="Chro" className="size-9" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">
        Welcome to Chro
      </h1>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
        Run your coding agents as real teammates — assign a task, watch it work
        in an isolated worktree, review the diff. Three quick steps.
      </p>
      <div className="mt-8 flex w-64 flex-col gap-3">
        <Button size="lg" onClick={onNext}>
          Get started
        </Button>
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            I've done this before →
          </button>
        ) : null}
      </div>
    </div>
  );
}
