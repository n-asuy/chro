import { describe, expect, it } from "vitest";
import {
  type SectionId,
  isSectionIdList,
  toggleSectionId,
} from "../projects-panel";

describe("toggleSectionId", () => {
  it("collapses a band that is currently expanded", () => {
    expect(toggleSectionId([], "projects")).toEqual(["projects"]);
    expect(toggleSectionId(["pinned"], "chats")).toEqual(["pinned", "chats"]);
  });

  it("expands a band that is currently collapsed", () => {
    expect(toggleSectionId(["projects"], "projects")).toEqual([]);
    expect(toggleSectionId(["pinned", "chats"], "pinned")).toEqual(["chats"]);
  });

  it("leaves the other bands untouched, so each collapses independently", () => {
    const collapsed = toggleSectionId(
      toggleSectionId(["pinned"], "chats"),
      "pinned",
    );
    expect(collapsed).toEqual(["chats"]);
  });

  it("never mutates the list it was given", () => {
    const before: readonly SectionId[] = ["pinned"];
    toggleSectionId(before, "projects");
    toggleSectionId(before, "pinned");
    expect(before).toEqual(["pinned"]);
  });
});

describe("isSectionIdList", () => {
  it("accepts persisted lists of known bands", () => {
    expect(isSectionIdList([])).toBe(true);
    expect(isSectionIdList(["pinned", "projects", "chats"])).toBe(true);
  });

  it("rejects anything else, so a stale value expands everything", () => {
    // A band renamed or dropped by a later version must not leave the user
    // with a permanently folded-away section they cannot name.
    expect(isSectionIdList(["projects", "inbox"])).toBe(false);
    expect(isSectionIdList("projects")).toBe(false);
    expect(isSectionIdList(null)).toBe(false);
    expect(isSectionIdList(undefined)).toBe(false);
    expect(isSectionIdList({ projects: true })).toBe(false);
  });
});
