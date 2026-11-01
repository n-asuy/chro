import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_MAP_PROJECT, useDirectoryMapStore } from "./directory-map-store";

const state = () => useDirectoryMapStore.getState();
beforeEach(() => useDirectoryMapStore.setState({ projects: {} }));

describe("per-project file tree", () => {
  it("starts every project on its sessions so no tree loads until asked", () => {
    expect(EMPTY_MAP_PROJECT.showsFiles).toBe(false);
    state().toggleFiles("alpha");
    expect(state().projects.alpha.showsFiles).toBe(true);
    expect(state().projects.beta).toBeUndefined();
    state().toggleFiles("alpha");
    expect(state().projects.alpha.showsFiles).toBe(false);
  });

  it("keeps directory folding across switches between sessions and files", () => {
    state().toggleFiles("alpha");
    state().toggleDirectory("alpha", "docs");
    state().toggleFiles("alpha");
    state().toggleFiles("alpha");
    expect(state().projects.alpha.expanded.has("docs")).toBe(true);
  });

  it("records session addresses while sessions are shown without expanding", () => {
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect(state().projects.alpha.showsFiles).toBe(false);
    expect([...state().projects.alpha.expanded]).toEqual([]);
    state().toggleFiles("alpha");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect([...state().projects.alpha.expanded]).toEqual([]);
  });

  it("reveals addresses that first appear while files are shown", () => {
    state().toggleFiles("alpha");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect([...state().projects.alpha.expanded].sort()).toEqual([
      "",
      "docs",
      "docs/nested",
    ]);
  });

  it("keeps manual directory folding when task updates repeat", () => {
    state().toggleFiles("alpha");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    state().toggleDirectory("alpha", "docs");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect(state().projects.alpha.expanded.has("docs")).toBe(false);
    state().toggleDirectory("alpha", "docs");
    expect(state().projects.alpha.expanded.has("docs")).toBe(true);
  });

  it("opens the tree down to a directory without switching the view", () => {
    state().revealDirectory("alpha", "crates/server/src");
    expect(state().projects.alpha.showsFiles).toBe(false);
    expect([...state().projects.alpha.expanded].sort()).toEqual([
      "",
      "crates",
      "crates/server",
      "crates/server/src",
    ]);
  });

  it("leaves the state untouched when there is nothing to open", () => {
    state().toggleFiles("alpha");
    const before = state().projects.alpha;
    state().revealDirectory("alpha", null);
    expect(state().projects.alpha).toBe(before);
  });

  it("adds to what the user already opened instead of replacing it", () => {
    state().toggleFiles("alpha");
    state().toggleDirectory("alpha", "docs");
    state().revealDirectory("alpha", "apps");
    expect(state().projects.alpha.expanded.has("docs")).toBe(true);
    expect(state().projects.alpha.expanded.has("apps")).toBe(true);
  });
});
