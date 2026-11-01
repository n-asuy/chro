import { describe, expect, it } from "vitest";
import { mediaViewerFor } from "../media-types";

describe("mediaViewerFor", () => {
  it.each([
    ["png", "image"],
    ["svg", "image"],
    ["mp4", "video"],
    ["mov", "video"],
    ["wav", "audio"],
    ["mp3", "audio"],
    ["flac", "audio"],
    ["m4a", "audio"],
    ["pdf", "pdf"],
  ] as const)("routes .%s to the %s viewer", (extension, viewer) => {
    expect(mediaViewerFor(extension)).toBe(viewer);
  });

  it("ignores case and a leading dot", () => {
    expect(mediaViewerFor("WAV")).toBe("audio");
    expect(mediaViewerFor(".wav")).toBe("audio");
  });

  it("leaves text and unknown files to the text editor", () => {
    expect(mediaViewerFor("md")).toBeNull();
    expect(mediaViewerFor("ts")).toBeNull();
    expect(mediaViewerFor("")).toBeNull();
    expect(mediaViewerFor(null)).toBeNull();
    expect(mediaViewerFor(undefined)).toBeNull();
  });
});
