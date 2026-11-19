import { describe, expect, it } from "vitest";
import {
  BAR_MAX_PX,
  BAR_MIN_PX,
  MAX_QUEUED,
  barHeights,
  enqueueLevels,
  pushRecent,
} from "./level-meter";

describe("barHeights", () => {
  it("rests on short equal stubs in silence", () => {
    expect(barHeights([])).toEqual([
      BAR_MIN_PX,
      BAR_MIN_PX,
      BAR_MIN_PX,
      BAR_MIN_PX,
    ]);
    expect(barHeights([0, 0, 0, 0])).toEqual([3, 3, 3, 3]);
  });

  it("reaches the mock's bar heights at full level", () => {
    expect(barHeights([1, 1, 1, 1])).toEqual([...BAR_MAX_PX]);
  });

  it("shows the latest four levels, oldest on the left", () => {
    expect(barHeights([0.9, 0, 0.5, 1, 0.25])).toEqual([3, 8, 13, 5.3]);
  });

  it("clamps levels outside 0..1", () => {
    expect(barHeights([-1, 2, 0, 0])).toEqual([3, 13, 3, 3]);
  });
});

describe("playback", () => {
  it("queues batches and drops the oldest when behind", () => {
    expect(enqueueLevels([0.1], [0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
    const behind = enqueueLevels([0, 0, 0, 0, 0], [0.4, 0.5, 0.6]);
    expect(behind).toHaveLength(MAX_QUEUED);
    expect(behind.slice(-3)).toEqual([0.4, 0.5, 0.6]);
  });

  it("keeps the last four played levels", () => {
    expect(pushRecent([0.1, 0.2, 0.3, 0.4], 0.5)).toEqual([0.2, 0.3, 0.4, 0.5]);
  });
});
