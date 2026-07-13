import { describe, expect, it } from "vitest";
import {
  type ChangelogRelease,
  parseChangelog,
  splitInlineCode,
} from "../changelog-parser";

describe("parseChangelog", () => {
  it("splits releases on level-2 headings, newest first", () => {
    const source = [
      "# Changelog",
      "",
      "## 0.1.40",
      "",
      "- Added a thing",
      "- Fixed another thing",
      "",
      "## 0.1.39",
      "",
      "- Reworked the picker",
      "",
    ].join("\n");

    expect(parseChangelog(source)).toEqual<ChangelogRelease[]>([
      { version: "0.1.40", notes: ["Added a thing", "Fixed another thing"] },
      { version: "0.1.39", notes: ["Reworked the picker"] },
    ]);
  });

  it("ignores the top-level title and intro prose before the first release", () => {
    const source = [
      "# Changelog",
      "",
      "Everything of note ships here.",
      "",
      "## 1.0.0",
      "- First release",
      "",
    ].join("\n");

    expect(parseChangelog(source)).toEqual<ChangelogRelease[]>([
      { version: "1.0.0", notes: ["First release"] },
    ]);
  });

  it("joins a bullet that wraps across multiple source lines", () => {
    const source = [
      "## 0.2.0",
      "- This note is long enough that it",
      "  wraps onto a second line",
      "- Short note",
    ].join("\n");

    expect(parseChangelog(source)).toEqual<ChangelogRelease[]>([
      {
        version: "0.2.0",
        notes: [
          "This note is long enough that it wraps onto a second line",
          "Short note",
        ],
      },
    ]);
  });

  it("accepts asterisk bullets and trims heading whitespace", () => {
    const source = ["##   0.3.0   ", "* Star bullet"].join("\n");

    expect(parseChangelog(source)).toEqual<ChangelogRelease[]>([
      { version: "0.3.0", notes: ["Star bullet"] },
    ]);
  });

  it("returns an empty list for a changelog with no releases", () => {
    expect(parseChangelog("# Changelog\n\nNothing yet.\n")).toEqual([]);
  });

  it("keeps a release with no notes as an empty-notes entry", () => {
    expect(parseChangelog("## 0.0.1\n")).toEqual<ChangelogRelease[]>([
      { version: "0.0.1", notes: [] },
    ]);
  });
});

describe("splitInlineCode", () => {
  it("splits plain and inline-code runs on backtick pairs", () => {
    expect(splitInlineCode("run `chro task logs` for the transcript")).toEqual([
      { code: false, text: "run " },
      { code: true, text: "chro task logs" },
      { code: false, text: " for the transcript" },
    ]);
  });

  it("treats an unterminated backtick as literal text", () => {
    expect(splitInlineCode("a stray ` backtick")).toEqual([
      { code: false, text: "a stray ` backtick" },
    ]);
  });

  it("handles a note with no code", () => {
    expect(splitInlineCode("plain note")).toEqual([
      { code: false, text: "plain note" },
    ]);
  });

  it("drops empty segments from adjacent backticks", () => {
    expect(splitInlineCode("`code`")).toEqual([{ code: true, text: "code" }]);
  });
});
