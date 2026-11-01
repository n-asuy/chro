/**
 * @vitest-environment jsdom
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  changeMarkers,
  lineChangeKinds,
  revertChange,
  setChangeBase,
  toggleChangePeek,
} from "../change-markers";

const BASE = "one\ntwo\nthree\nfour\n";

let view: EditorView | null = null;

const mount = (doc: string, base: string | null = BASE) => {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [changeMarkers()] }),
  });
  view.dispatch({ effects: setChangeBase.of(base) });
  return view;
};

const kinds = (v: EditorView) => Object.fromEntries(lineChangeKinds(v.state));

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("change markers", () => {
  it("marks nothing without a base or without changes", () => {
    expect(kinds(mount("x\n", null))).toEqual({});
    expect(kinds(mount(BASE))).toEqual({});
  });

  it("marks modified, added and deleted lines", () => {
    expect(kinds(mount("one\nTWO\nthree\nfour\n"))).toEqual({ 2: "modified" });
    expect(kinds(mount("one\ntwo\nnew\nthree\nfour\n"))).toEqual({
      3: "added",
    });
    expect(kinds(mount("one\nthree\nfour\n"))).toEqual({ 2: "deleted" });
  });

  it("follows edits", () => {
    const v = mount(BASE);
    v.dispatch({ changes: { from: 0, insert: "zero " } });
    expect(kinds(v)).toEqual({ 1: "modified" });
    v.dispatch({ changes: { from: 0, to: 5 } });
    expect(kinds(v)).toEqual({});
  });

  it("peeks the original lines of a change in place", () => {
    const v = mount("one\nTWO\nthree\nfour\n");
    toggleChangePeek(v, v.state.doc.line(2).from);
    const peek = document.querySelector(".cm-change-peek");
    expect(peek?.textContent).toContain("two");
    toggleChangePeek(v, v.state.doc.line(2).from);
    expect(document.querySelector(".cm-change-peek")).toBeNull();
  });

  it("peeks a deletion and reverts it", () => {
    const v = mount("one\nthree\nfour\n");
    toggleChangePeek(v, v.state.doc.line(2).from);
    expect(document.querySelector(".cm-change-peek")?.textContent).toContain(
      "two",
    );
    expect(revertChange(v, v.state.doc.line(2).from)).toBe(true);
    expect(v.state.doc.toString()).toBe(BASE);
    expect(document.querySelector(".cm-change-peek")).toBeNull();
  });

  it.each([
    ["one\nTWO\nthree\nfour\n", 2],
    ["one\ntwo\nnew\nthree\nfour\n", 3],
    ["one\ntwo\nthree\nfour\nfive", 5],
    ["one\ntwo\nthree\nFOUR", 4],
  ])("reverts %j back to the base", (doc, line) => {
    const v = mount(doc);
    expect(revertChange(v, v.state.doc.line(line).from)).toBe(true);
    expect(v.state.doc.toString()).toBe(BASE);
  });

  it("reverts through the peek's button", () => {
    const v = mount("one\nTWO\nthree\nfour\n");
    toggleChangePeek(v, v.state.doc.line(2).from);
    document
      .querySelector<HTMLButtonElement>(".cm-change-peek [data-action=revert]")
      ?.click();
    expect(v.state.doc.toString()).toBe(BASE);
  });

  it("draws one gutter marker per changed line", () => {
    mount("one\nTWO\nthree\nnew\nfour\n");
    const markers = [
      ...document.querySelectorAll(".cm-change-gutter .cm-change-marker"),
    ].map((m) => m.className);
    expect(markers).toEqual([
      "cm-change-marker cm-change-modified",
      "cm-change-marker cm-change-added",
    ]);
  });
});
