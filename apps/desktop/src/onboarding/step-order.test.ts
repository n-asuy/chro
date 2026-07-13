import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEP_ORDER,
  nextOnboardingStep,
  onboardingProgress,
  previousOnboardingStep,
} from "./step-order";

describe("onboarding step order", () => {
  it("welcome is not part of the persisted sequence", () => {
    expect(ONBOARDING_STEP_ORDER).not.toContain("welcome");
    expect(ONBOARDING_STEP_ORDER).toEqual(["agent", "theme", "workspace"]);
  });

  describe("nextOnboardingStep", () => {
    it("enters the first persisted step from welcome", () => {
      expect(nextOnboardingStep("welcome")).toBe("agent");
    });

    it("walks the persisted sequence in order", () => {
      expect(nextOnboardingStep("agent")).toBe("theme");
      expect(nextOnboardingStep("theme")).toBe("workspace");
    });

    it("returns null past the last step", () => {
      expect(nextOnboardingStep("workspace")).toBeNull();
    });
  });

  describe("previousOnboardingStep", () => {
    it("has nothing before welcome", () => {
      expect(previousOnboardingStep("welcome")).toBeNull();
    });

    it("returns from the first persisted step to welcome", () => {
      expect(previousOnboardingStep("agent")).toBe("welcome");
    });

    it("walks the persisted sequence backwards", () => {
      expect(previousOnboardingStep("theme")).toBe("agent");
      expect(previousOnboardingStep("workspace")).toBe("theme");
    });
  });

  describe("onboardingProgress", () => {
    it("hides the indicator on welcome", () => {
      expect(onboardingProgress("welcome")).toBeNull();
    });

    it("reports 0-based index against the persisted total", () => {
      expect(onboardingProgress("agent")).toEqual({ index: 0, total: 3 });
      expect(onboardingProgress("theme")).toEqual({ index: 1, total: 3 });
      expect(onboardingProgress("workspace")).toEqual({ index: 2, total: 3 });
    });
  });

  it("next/previous are inverse across the whole sequence", () => {
    for (const step of ONBOARDING_STEP_ORDER) {
      const next = nextOnboardingStep(step);
      if (next) {
        expect(previousOnboardingStep(next)).toBe(step);
      }
    }
  });
});
