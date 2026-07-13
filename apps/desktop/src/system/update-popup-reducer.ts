export type UpdatePopupView =
  | { type: "hidden" }
  | { type: "available"; version: string; releaseNotes: string | null }
  | { type: "downloading"; version: string | null; percent: number }
  | { type: "downloaded"; version: string | null }
  | { type: "error"; message: string; version: string | null };

export interface UpdateModel {
  view: UpdatePopupView;
  latestVersion: string | null;
  dismissedVersion: string | null;
  progressDismissed: boolean;
}

export type UpdateEvent =
  | { type: "status"; status: UpdateStatus }
  | { type: "dismiss" }
  | { type: "error"; message: string };

export const initialModel: UpdateModel = {
  view: { type: "hidden" },
  latestVersion: null,
  dismissedVersion: null,
  progressDismissed: false,
};

export const clampPercent = (value: number): number =>
  Math.max(0, Math.min(100, value));

export const formatVersion = (version: string): string =>
  version.startsWith("v") ? version : `v${version}`;

const stripHtmlTags = (value: string): string =>
  value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const isNoiseReleaseLine = (value: string): boolean =>
  /^release\s+desktop\s+v?\d+\.\d+\.\d+$/i.test(value);

export const getReleasePreview = (notes: string | null): string | null => {
  if (!notes) return null;
  for (const entry of notes.split(/\r?\n/)) {
    const clean = stripHtmlTags(entry);
    if (!clean || isNoiseReleaseLine(clean)) continue;
    return clean;
  }
  return null;
};

// ── Reducer ────────────────────────────────────────────────────────────

export function updateReducer(
  model: UpdateModel,
  event: UpdateEvent,
): UpdateModel {
  switch (event.type) {
    case "status":
      return applyStatus(model, event.status);
    case "dismiss":
      return applyDismiss(model);
    case "error":
      return {
        ...model,
        view: {
          type: "error",
          message: event.message,
          version: model.latestVersion,
        },
      };
  }
}

// ── Status transitions ─────────────────────────────────────────────────

function applyStatus(model: UpdateModel, status: UpdateStatus): UpdateModel {
  switch (status.type) {
    case "available": {
      if (model.dismissedVersion === status.version) {
        return {
          ...model,
          latestVersion: status.version,
          progressDismissed: false,
        };
      }
      return {
        ...model,
        latestVersion: status.version,
        progressDismissed: false,
        view: {
          type: "available",
          version: status.version,
          releaseNotes: status.releaseNotes ?? null,
        },
      };
    }

    case "downloading": {
      if (model.progressDismissed) return model;
      return {
        ...model,
        view: {
          type: "downloading",
          version: model.latestVersion,
          percent: clampPercent(status.percent),
        },
      };
    }

    case "downloaded": {
      const version = status.version ?? model.latestVersion;
      if (model.dismissedVersion === version) {
        return {
          ...model,
          latestVersion: version,
          progressDismissed: false,
        };
      }
      return {
        ...model,
        latestVersion: version,
        progressDismissed: false,
        dismissedVersion: null,
        view: { type: "downloaded", version },
      };
    }

    case "error":
      return {
        ...model,
        progressDismissed: false,
        view: {
          type: "error",
          message: status.message,
          version: model.latestVersion,
        },
      };

    case "not-available": {
      if (
        model.view.type === "downloading" ||
        model.view.type === "downloaded"
      ) {
        return model;
      }
      return {
        ...model,
        latestVersion: null,
        progressDismissed: false,
        view: { type: "hidden" },
      };
    }

    case "checking":
    default:
      return model;
  }
}

// ── Dismiss ────────────────────────────────────────────────────────────

function applyDismiss(model: UpdateModel): UpdateModel {
  switch (model.view.type) {
    case "available":
      return {
        ...model,
        view: { type: "hidden" },
        dismissedVersion: model.view.version,
      };

    case "downloading":
      return {
        ...model,
        view: { type: "hidden" },
        progressDismissed: true,
      };

    case "downloaded":
      return {
        ...model,
        view: { type: "hidden" },
        dismissedVersion: model.view.version ?? model.latestVersion,
        progressDismissed: false,
      };

    case "error":
    case "hidden":
    default:
      return {
        ...model,
        view: { type: "hidden" },
      };
  }
}
