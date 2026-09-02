import posthog from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { capture, initAnalytics, isEgressAllowed } from "../analytics";
import { pendingDevEventsForTest, resetDevEventsForTest } from "../dev-events";

vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}));

describe("analytics egress allowlist", () => {
  beforeEach(() => {
    resetDevEventsForTest();
    vi.mocked(posthog.capture).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    initAnalytics({ enabled: true });
  });

  afterEach(() => {
    resetDevEventsForTest();
    vi.restoreAllMocks();
  });

  it("admits the product events and nothing else", () => {
    expect(isEgressAllowed("app_opened")).toBe(true);
    expect(isEgressAllowed("error_boundary")).toBe(true);
    expect(isEgressAllowed("execution_started")).toBe(true);

    for (const local of ["rpc", "ui.click", "ui.key", "ui.route"]) {
      expect(isEgressAllowed(local)).toBe(false);
    }
  });

  it("transmits an allowlisted event", () => {
    capture("app_opened");
    expect(posthog.capture).toHaveBeenCalledWith(
      "app_opened",
      expect.objectContaining({ app_version: expect.any(String) }),
    );
  });

  it("keeps an unlisted event local, however it was captured", () => {
    capture("ui.click", { label: "Merge" });
    capture("some_new_instrumentation", { value: 1 });

    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("mirrors every captured event into the local sink either way", () => {
    capture("app_opened");
    capture("ui.click", { label: "Merge" });

    expect(pendingDevEventsForTest().map((entry) => entry.event)).toEqual([
      "app_opened",
      "ui.click",
    ]);
  });
});
