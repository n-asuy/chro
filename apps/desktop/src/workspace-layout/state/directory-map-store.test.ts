import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_MAP_PROJECT, useDirectoryMapStore } from "./directory-map-store";

const state = () => useDirectoryMapStore.getState();
beforeEach(() => useDirectoryMapStore.setState({ projects: {} }));

describe("directory map folding", () => {
  it("starts every project folded so nothing loads until the user opens it", () => {
    expect(EMPTY_MAP_PROJECT.collapsed).toBe(true);
    state().toggleProject("alpha");
    expect(state().projects.alpha.collapsed).toBe(false);
    state().toggleProject("alpha");
    expect(state().projects.alpha.collapsed).toBe(true);
  });

  it("records session addresses of a folded project without expanding it", () => {
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect(state().projects.alpha.collapsed).toBe(true);
    expect([...state().projects.alpha.expanded]).toEqual([]);
    state().toggleProject("alpha");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect([...state().projects.alpha.expanded]).toEqual([]);
  });

  it("reveals addresses that first appear while the project is open", () => {
    state().toggleProject("alpha");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect([...state().projects.alpha.expanded].sort()).toEqual([
      "",
      "docs",
      "docs/nested",
    ]);
  });

  it("collapses every level and stays folded when existing sessions arrive again", () => {
    state().toggleProject("alpha");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    state().toggleProject("beta");
    state().revealHomedDirectories("beta", ["apps"]);
    state().collapseAll(["alpha", "beta"]);
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect(state().projects.alpha.collapsed).toBe(true);
    expect([...state().projects.alpha.expanded]).toEqual([]);
    expect(state().projects.beta.collapsed).toBe(true);
    state().toggleProject("alpha");
    expect(state().projects.alpha.collapsed).toBe(false);
    expect([...state().projects.alpha.expanded]).toEqual([]);
  });

  it("keeps manual directory folding when task updates repeat", () => {
    state().toggleProject("alpha");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    state().toggleDirectory("alpha", "docs");
    state().revealHomedDirectories("alpha", ["docs/nested"]);
    expect(state().projects.alpha.expanded.has("docs")).toBe(false);
    state().toggleDirectory("alpha", "docs");
    expect(state().projects.alpha.expanded.has("docs")).toBe(true);
  });
});
