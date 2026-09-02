import { describe, expect, it } from "vitest";
import {
  LARGE_TEXT_SAFE_MODE_BYTES,
  isLargeTextSafeMode,
  resolveCodeViewState,
} from "./editor-safe-mode";

const SMALL = 4 * 1024;
const LARGE = LARGE_TEXT_SAFE_MODE_BYTES + 1;

const codeView = (
  overrides: Partial<Parameters<typeof resolveCodeViewState>[0]> = {},
) =>
  resolveCodeViewState({
    fileSizeBytes: SMALL,
    isHtml: false,
    htmlViewMode: "preview",
    fullscreenRequested: false,
    ...overrides,
  });

describe("isLargeTextSafeMode", () => {
  it("treats an unknown size as small", () => {
    expect(isLargeTextSafeMode(null)).toBe(false);
    expect(isLargeTextSafeMode(undefined)).toBe(false);
  });

  it("engages strictly above the threshold", () => {
    expect(isLargeTextSafeMode(LARGE_TEXT_SAFE_MODE_BYTES)).toBe(false);
    expect(isLargeTextSafeMode(LARGE)).toBe(true);
  });
});

describe("resolveCodeViewState", () => {
  it("drops decorations for a large document", () => {
    const state = codeView({ fileSizeBytes: LARGE });
    expect(state.largeTextSafeMode).toBe(true);
    expect(state.syntaxHighlighting).toBe(false);
    expect(state.lineWrapping).toBe(false);
    expect(state.showSafeModeNotice).toBe(true);
  });

  it("keeps decorations for an ordinary document", () => {
    const state = codeView();
    expect(state.syntaxHighlighting).toBe(true);
    expect(state.lineWrapping).toBe(true);
    expect(state.showSafeModeNotice).toBe(false);
  });

  // The preview is an iframe pointed at the asset URL, so document size costs
  // the editor nothing. Gating it on safe mode left large pages unviewable.
  it("still previews a large HTML file", () => {
    const state = codeView({ fileSizeBytes: LARGE, isHtml: true });
    expect(state.showHtmlPreview).toBe(true);
    expect(state.showHtmlToolbar).toBe(true);
  });

  it("hides the safe-mode notice while the preview is showing", () => {
    expect(
      codeView({ fileSizeBytes: LARGE, isHtml: true }).showSafeModeNotice,
    ).toBe(false);
  });

  it("reports the notice once a large HTML file switches to raw source", () => {
    const state = codeView({
      fileSizeBytes: LARGE,
      isHtml: true,
      htmlViewMode: "raw",
    });
    expect(state.showHtmlPreview).toBe(false);
    expect(state.showSafeModeNotice).toBe(true);
  });

  it("offers the view switch on a large HTML file so raw stays reachable", () => {
    expect(
      codeView({ fileSizeBytes: LARGE, isHtml: true }).showHtmlToolbar,
    ).toBe(true);
  });

  it("only goes fullscreen while previewing", () => {
    expect(
      codeView({ isHtml: true, fullscreenRequested: true }).showHtmlFullscreen,
    ).toBe(true);
    expect(
      codeView({
        isHtml: true,
        htmlViewMode: "raw",
        fullscreenRequested: true,
      }).showHtmlFullscreen,
    ).toBe(false);
  });

  it("shows no HTML affordances for a non-HTML file", () => {
    const state = codeView();
    expect(state.showHtmlPreview).toBe(false);
    expect(state.showHtmlToolbar).toBe(false);
    expect(state.showHtmlFullscreen).toBe(false);
  });
});
