import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  getUiValue: vi.fn(),
  setUiValue: vi.fn(),
  isUiStateReady: vi.fn(),
}));

vi.mock("@/lib/ui-state-client", () => ({
  getUiValue: mock.getUiValue,
  setUiValue: mock.setUiValue,
  isUiStateReady: mock.isUiStateReady,
}));

import {
  isOnboardingComplete,
  markOnboardingComplete,
  useOnboardingStore,
} from "./use-onboarding";

const COMPLETE_KEY = "chro:setup-onboarding-complete";

describe("onboarding completion flag", () => {
  beforeEach(() => {
    mock.getUiValue.mockReset();
    mock.setUiValue.mockReset();
    mock.isUiStateReady.mockReset();
    useOnboardingStore.setState({ isOpen: false });
  });

  it("reads completion from the preserved setup key", () => {
    mock.getUiValue.mockReturnValue(true);
    expect(isOnboardingComplete()).toBe(true);
    expect(mock.getUiValue).toHaveBeenCalledWith(COMPLETE_KEY);
  });

  it("treats a missing flag as not complete", () => {
    mock.getUiValue.mockReturnValue(null);
    expect(isOnboardingComplete()).toBe(false);
  });

  it("persists completion under the preserved key", () => {
    markOnboardingComplete();
    expect(mock.setUiValue).toHaveBeenCalledWith(COMPLETE_KEY, true);
  });

  it("complete() closes the flow and persists the flag", () => {
    useOnboardingStore.setState({ isOpen: true });
    useOnboardingStore.getState().complete();
    expect(useOnboardingStore.getState().isOpen).toBe(false);
    expect(mock.setUiValue).toHaveBeenCalledWith(COMPLETE_KEY, true);
  });

  it("open() reveals the flow without touching the flag", () => {
    useOnboardingStore.getState().open();
    expect(useOnboardingStore.getState().isOpen).toBe(true);
    expect(mock.setUiValue).not.toHaveBeenCalled();
  });
});
