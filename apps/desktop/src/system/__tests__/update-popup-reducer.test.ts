import { describe, expect, it } from "vitest";
import {
  type UpdateEvent,
  type UpdateModel,
  clampPercent,
  formatVersion,
  getReleasePreview,
  initialModel,
  updateReducer,
} from "../update-popup-reducer";

const dispatch = (model: UpdateModel, ...events: UpdateEvent[]): UpdateModel =>
  events.reduce(updateReducer, model);

const status = (s: UpdateStatus): UpdateEvent => ({ type: "status", status: s });
const dismiss: UpdateEvent = { type: "dismiss" };
const error = (message: string): UpdateEvent => ({ type: "error", message });

// ── Initial state ──────────────────────────────────────────────────────

describe("initialModel", () => {
  it("starts with hidden view and null values", () => {
    expect(initialModel).toEqual({
      view: { type: "hidden" },
      latestVersion: null,
      dismissedVersion: null,
      progressDismissed: false,
    });
  });
});

// ── Status: available ──────────────────────────────────────────────────

describe("status: available", () => {
  it("shows popup with version and release notes", () => {
    const result = dispatch(
      initialModel,
      status({ type: "available", version: "1.2.0", releaseNotes: "bug fixes" }),
    );
    expect(result.view).toEqual({
      type: "available",
      version: "1.2.0",
      releaseNotes: "bug fixes",
    });
  });

  it("updates latestVersion", () => {
    const result = dispatch(
      initialModel,
      status({ type: "available", version: "1.2.0" }),
    );
    expect(result.latestVersion).toBe("1.2.0");
  });

  it("normalizes missing releaseNotes to null", () => {
    const result = dispatch(
      initialModel,
      status({ type: "available", version: "1.2.0" }),
    );
    expect(result.view.type === "available" && result.view.releaseNotes).toBeNull();
  });

  it("ignores if version matches dismissedVersion", () => {
    const model: UpdateModel = {
      ...initialModel,
      dismissedVersion: "1.2.0",
    };
    const result = dispatch(
      model,
      status({ type: "available", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("hidden");
  });

  it("still updates latestVersion when dismissed", () => {
    const model: UpdateModel = {
      ...initialModel,
      dismissedVersion: "1.2.0",
    };
    const result = dispatch(
      model,
      status({ type: "available", version: "1.2.0" }),
    );
    expect(result.latestVersion).toBe("1.2.0");
  });

  it("shows popup for a different version even if another was dismissed", () => {
    const model: UpdateModel = {
      ...initialModel,
      dismissedVersion: "1.1.0",
    };
    const result = dispatch(
      model,
      status({ type: "available", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("available");
  });

  it("clears progressDismissed", () => {
    const model: UpdateModel = {
      ...initialModel,
      progressDismissed: true,
    };
    const result = dispatch(
      model,
      status({ type: "available", version: "2.0.0" }),
    );
    expect(result.progressDismissed).toBe(false);
  });
});

// ── Status: downloading ────────────────────────────────────────────────

describe("status: downloading", () => {
  it("shows download progress", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "available", version: "1.2.0", releaseNotes: null },
    };
    const result = dispatch(
      model,
      status({ type: "downloading", percent: 42 }),
    );
    expect(result.view).toEqual({
      type: "downloading",
      version: "1.2.0",
      percent: 42,
    });
  });

  it("clamps percent to 0-100", () => {
    const model: UpdateModel = { ...initialModel, latestVersion: "1.0.0" };
    const over = dispatch(model, status({ type: "downloading", percent: 150 }));
    const under = dispatch(model, status({ type: "downloading", percent: -10 }));
    expect(over.view.type === "downloading" && over.view.percent).toBe(100);
    expect(under.view.type === "downloading" && under.view.percent).toBe(0);
  });

  it("uses latestVersion from model", () => {
    const model: UpdateModel = { ...initialModel, latestVersion: "3.0.0" };
    const result = dispatch(model, status({ type: "downloading", percent: 10 }));
    expect(result.view.type === "downloading" && result.view.version).toBe("3.0.0");
  });

  it("suppresses when progressDismissed is true", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      progressDismissed: true,
      view: { type: "hidden" },
    };
    const result = dispatch(
      model,
      status({ type: "downloading", percent: 50 }),
    );
    expect(result.view.type).toBe("hidden");
  });
});

// ── Status: downloaded ─────────────────────────────────────────────────

describe("status: downloaded", () => {
  it("shows downloaded notification", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "downloading", version: "1.2.0", percent: 99 },
    };
    const result = dispatch(
      model,
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(result.view).toEqual({ type: "downloaded", version: "1.2.0" });
  });

  it("uses status version", () => {
    const model: UpdateModel = { ...initialModel, latestVersion: "1.1.0" };
    const result = dispatch(
      model,
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(result.view.type === "downloaded" && result.view.version).toBe("1.2.0");
    expect(result.latestVersion).toBe("1.2.0");
  });

  it("clears dismissedVersion on show", () => {
    const model: UpdateModel = {
      ...initialModel,
      dismissedVersion: "1.0.0",
      latestVersion: "1.2.0",
    };
    const result = dispatch(
      model,
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(result.dismissedVersion).toBeNull();
  });

  it("clears progressDismissed", () => {
    const model: UpdateModel = {
      ...initialModel,
      progressDismissed: true,
      latestVersion: "1.2.0",
    };
    const result = dispatch(
      model,
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(result.progressDismissed).toBe(false);
  });

  it("suppresses when dismissedVersion matches", () => {
    const model: UpdateModel = {
      ...initialModel,
      dismissedVersion: "1.2.0",
      latestVersion: "1.2.0",
    };
    const result = dispatch(
      model,
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("hidden");
  });

  it("shows even when progressDismissed (download completed notification)", () => {
    const model: UpdateModel = {
      ...initialModel,
      progressDismissed: true,
      latestVersion: "1.2.0",
    };
    const result = dispatch(
      model,
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("downloaded");
    expect(result.progressDismissed).toBe(false);
  });
});

// ── Status: error ──────────────────────────────────────────────────────

describe("status: error", () => {
  it("shows error with message and latestVersion", () => {
    const model: UpdateModel = { ...initialModel, latestVersion: "1.2.0" };
    const result = dispatch(
      model,
      status({ type: "error", message: "Network failure" }),
    );
    expect(result.view).toEqual({
      type: "error",
      message: "Network failure",
      version: "1.2.0",
    });
  });

  it("clears progressDismissed", () => {
    const model: UpdateModel = {
      ...initialModel,
      progressDismissed: true,
    };
    const result = dispatch(
      model,
      status({ type: "error", message: "fail" }),
    );
    expect(result.progressDismissed).toBe(false);
  });
});

// ── Status: not-available ──────────────────────────────────────────────

describe("status: not-available", () => {
  it("hides popup and clears latestVersion", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "available", version: "1.2.0", releaseNotes: null },
    };
    const result = dispatch(
      model,
      status({ type: "not-available", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("hidden");
    expect(result.latestVersion).toBeNull();
  });

  it("preserves downloading state and latestVersion", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "downloading", version: "1.2.0", percent: 50 },
    };
    const result = dispatch(
      model,
      status({ type: "not-available", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("downloading");
    expect(result.latestVersion).toBe("1.2.0");
  });

  it("preserves downloaded state and latestVersion", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "downloaded", version: "1.2.0" },
    };
    const result = dispatch(
      model,
      status({ type: "not-available", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("downloaded");
    expect(result.latestVersion).toBe("1.2.0");
  });
});

// ── Status: checking ───────────────────────────────────────────────────

describe("status: checking", () => {
  it("is a no-op", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "available", version: "1.2.0", releaseNotes: null },
    };
    const result = dispatch(model, status({ type: "checking" }));
    expect(result).toEqual(model);
  });
});

// ── Dismiss ────────────────────────────────────────────────────────────

describe("dismiss", () => {
  it("from available: hides and sets dismissedVersion", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "available", version: "1.2.0", releaseNotes: null },
    };
    const result = dispatch(model, dismiss);
    expect(result.view.type).toBe("hidden");
    expect(result.dismissedVersion).toBe("1.2.0");
  });

  it("from downloading: hides and sets progressDismissed", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "downloading", version: "1.2.0", percent: 50 },
    };
    const result = dispatch(model, dismiss);
    expect(result.view.type).toBe("hidden");
    expect(result.progressDismissed).toBe(true);
    expect(result.dismissedVersion).toBeNull();
  });

  it("from downloaded: hides and sets dismissedVersion", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      view: { type: "downloaded", version: "1.2.0" },
    };
    const result = dispatch(model, dismiss);
    expect(result.view.type).toBe("hidden");
    expect(result.dismissedVersion).toBe("1.2.0");
  });

  it("from error: hides without setting dismiss state", () => {
    const model: UpdateModel = {
      ...initialModel,
      latestVersion: "1.2.0",
      dismissedVersion: null,
      view: { type: "error", message: "fail", version: "1.2.0" },
    };
    const result = dispatch(model, dismiss);
    expect(result.view.type).toBe("hidden");
    expect(result.dismissedVersion).toBeNull();
    expect(result.progressDismissed).toBe(false);
  });
});

// ── Error event ────────────────────────────────────────────────────────

describe("error event", () => {
  it("shows error popup with latestVersion", () => {
    const model: UpdateModel = { ...initialModel, latestVersion: "1.2.0" };
    const result = dispatch(model, error("Download failed"));
    expect(result.view).toEqual({
      type: "error",
      message: "Download failed",
      version: "1.2.0",
    });
  });
});

// ── Integration flows ──────────────────────────────────────────────────

describe("flows", () => {
  it("normal: available → downloading → downloaded", () => {
    const result = dispatch(
      initialModel,
      status({ type: "available", version: "1.2.0", releaseNotes: "fix" }),
      status({ type: "downloading", percent: 0 }),
      status({ type: "downloading", percent: 50 }),
      status({ type: "downloading", percent: 100 }),
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(result.view).toEqual({ type: "downloaded", version: "1.2.0" });
    expect(result.latestVersion).toBe("1.2.0");
    expect(result.progressDismissed).toBe(false);
  });

  it("dismiss available → same version ignored on re-check", () => {
    const result = dispatch(
      initialModel,
      status({ type: "available", version: "1.2.0" }),
      dismiss,
      status({ type: "available", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("hidden");
    expect(result.dismissedVersion).toBe("1.2.0");
  });

  it("dismiss available → different version shows", () => {
    const result = dispatch(
      initialModel,
      status({ type: "available", version: "1.2.0" }),
      dismiss,
      status({ type: "available", version: "1.3.0" }),
    );
    expect(result.view.type).toBe("available");
    expect(result.view.type === "available" && result.view.version).toBe("1.3.0");
  });

  it("dismiss during downloading → progress suppressed → downloaded shows", () => {
    const result = dispatch(
      initialModel,
      status({ type: "available", version: "1.2.0" }),
      status({ type: "downloading", percent: 30 }),
      dismiss,
      // Further progress events suppressed
      status({ type: "downloading", percent: 60 }),
      status({ type: "downloading", percent: 90 }),
    );
    expect(result.view.type).toBe("hidden");
    expect(result.progressDismissed).toBe(true);

    // Download completes → user should be notified
    const final = dispatch(
      result,
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(final.view.type).toBe("downloaded");
    expect(final.progressDismissed).toBe(false);
  });

  it("dismiss downloaded → same version downloaded event suppressed", () => {
    const result = dispatch(
      initialModel,
      status({ type: "available", version: "1.2.0" }),
      status({ type: "downloading", percent: 0 }),
      status({ type: "downloaded", version: "1.2.0" }),
      dismiss,
      status({ type: "downloaded", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("hidden");
    expect(result.dismissedVersion).toBe("1.2.0");
  });

  it("error → retry → available (new cycle)", () => {
    const result = dispatch(
      initialModel,
      status({ type: "error", message: "Network error" }),
      dismiss,
      status({ type: "available", version: "1.2.0" }),
    );
    expect(result.view.type).toBe("available");
  });
});

// ── Utility functions ──────────────────────────────────────────────────

describe("clampPercent", () => {
  it("clamps below 0", () => expect(clampPercent(-5)).toBe(0));
  it("clamps above 100", () => expect(clampPercent(120)).toBe(100));
  it("passes through valid values", () => expect(clampPercent(42)).toBe(42));
});

describe("formatVersion", () => {
  it("prepends v if missing", () => expect(formatVersion("1.2.0")).toBe("v1.2.0"));
  it("keeps existing v prefix", () => expect(formatVersion("v1.2.0")).toBe("v1.2.0"));
});

describe("getReleasePreview", () => {
  it("returns null for null input", () => {
    expect(getReleasePreview(null)).toBeNull();
  });

  it("returns first meaningful line", () => {
    expect(getReleasePreview("Fixed a critical bug\nOther changes")).toBe(
      "Fixed a critical bug",
    );
  });

  it("skips noise release lines", () => {
    expect(
      getReleasePreview("Release Desktop v1.2.0\nActual change note"),
    ).toBe("Actual change note");
  });

  it("strips HTML tags", () => {
    expect(getReleasePreview("<p>Fixed <b>bug</b></p>")).toBe("Fixed bug");
  });

  it("skips empty lines", () => {
    expect(getReleasePreview("\n\n\nReal note")).toBe("Real note");
  });

  it("returns null when all lines are noise", () => {
    expect(getReleasePreview("Release Desktop v1.2.0\n")).toBeNull();
  });
});
