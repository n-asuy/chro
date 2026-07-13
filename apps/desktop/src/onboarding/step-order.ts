/**
 * Single source of truth for the onboarding step sequence.
 *
 * Every navigation decision (what comes next, what came before, the progress
 * indicator's index/total) is derived from this one array. Adding, removing, or
 * reordering a step means editing `ONBOARDING_STEP_ORDER` and nothing else.
 *
 * `welcome` is intentionally NOT in the array: it's a first-entry product intro,
 * not a setup step, so it shows no progress indicator and is never "resumed"
 * into. It is always the entry point and hard-codes its own next hop.
 */
export type PersistedOnboardingStep = "agent" | "theme" | "workspace";

export type OnboardingStep = "welcome" | PersistedOnboardingStep;

export const ONBOARDING_STEP_ORDER: readonly PersistedOnboardingStep[] = [
  "agent",
  "theme",
  "workspace",
] as const;

/**
 * The step after `from`, or null if `from` is the last step. Welcome resolves
 * to the first persisted step.
 */
export function nextOnboardingStep(from: OnboardingStep): OnboardingStep | null {
  if (from === "welcome") {
    return ONBOARDING_STEP_ORDER[0] ?? null;
  }
  const index = ONBOARDING_STEP_ORDER.indexOf(from);
  if (index < 0 || index >= ONBOARDING_STEP_ORDER.length - 1) {
    return null;
  }
  return ONBOARDING_STEP_ORDER[index + 1] ?? null;
}

/**
 * The step before `from`, or null if `from` is welcome. The first persisted
 * step returns to welcome.
 */
export function previousOnboardingStep(
  from: OnboardingStep,
): OnboardingStep | null {
  if (from === "welcome") {
    return null;
  }
  const index = ONBOARDING_STEP_ORDER.indexOf(from);
  if (index <= 0) {
    return "welcome";
  }
  return ONBOARDING_STEP_ORDER[index - 1] ?? null;
}

/**
 * Progress position of a persisted step (`index` is 0-based). Welcome has no
 * progress, so it returns null and the indicator is hidden.
 */
export function onboardingProgress(
  step: OnboardingStep,
): { index: number; total: number } | null {
  if (step === "welcome") {
    return null;
  }
  const index = ONBOARDING_STEP_ORDER.indexOf(step);
  if (index < 0) {
    return null;
  }
  return { index, total: ONBOARDING_STEP_ORDER.length };
}
