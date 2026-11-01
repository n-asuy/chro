import { markdown } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type StateCommand,
  type Transaction,
} from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  deleteParagraph,
  insertMarkdownLink,
  toggleChecklist,
  toggleComment,
  toggleInlineMark,
} from "../markdown-formatting";
import {
  continueMarkup,
  continueMarkupSoft,
  indentListLess,
  indentListMore,
  lineStartAfterMarkup,
} from "../markdown-lists";

/**
 * Expected results are the reference editor's, recorded by replaying the same
 * keystrokes in it. "|" is the cursor, "[...]" a selection.
 */

const parse = (spec: string) => {
  let text = "";
  let anchor: number | undefined;
  let head: number | undefined;
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === "|") {
      anchor = text.length;
      head = text.length;
    } else if (c === "«") anchor = text.length;
    else if (c === "»") head = text.length;
    else text += c;
  }
  const a = anchor ?? text.length;
  return { text, anchor: a, head: head ?? a };
};

const render = (state: EditorState) => {
  const { anchor, head } = state.selection.main;
  const doc = state.doc.toString();
  const [from, to] = [Math.min(anchor, head), Math.max(anchor, head)];
  if (from === to) return `${doc.slice(0, from)}|${doc.slice(from)}`;
  return `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`;
};

const stateFor = (spec: string) => {
  const { text, anchor, head } = parse(spec);
  return EditorState.create({
    doc: text,
    selection: EditorSelection.single(anchor, head),
    extensions: [markdown(), indentUnit.of("\t"), EditorState.tabSize.of(4)],
  });
};

const run = (command: StateCommand, spec: string): string | null => {
  let result: Transaction | null = null;
  const handled = command({
    state: stateFor(spec),
    dispatch: (tr) => {
      result = tr;
    },
  });
  if (!handled) return null;
  const tr = result as Transaction | null;
  return tr ? render(tr.state) : spec;
};

describe("continueMarkup (Enter)", () => {
  it.each([
    ["- item|", "- item\n- |"],
    ["* item|", "* item\n* |"],
    ["+ item|", "+ item\n+ |"],
    ["1. one|", "1. one\n2. |"],
    ["1) a|", "1) a\n2) |"],
    ["- [ ] todo|", "- [ ] todo\n- [ ] |"],
    ["- [x] done|", "- [x] done\n- [ ] |"],
    ["1. [ ] a|", "1. [ ] a\n2. [ ] |"],
    ["- ab|cd", "- ab\n- |cd"],
    ["- |item", "- \n- |item"],
    ["- a\n\t- b|", "- a\n\t- b\n\t- |"],
    ["- a\n\n- b|", "- a\n\n- b\n- |"],
    ["> - a|", "> - a\n> - |"],
    ["> quote|", "> quote\n> |"],
    ["> > a|", "> > a\n> > |"],
    ["> a\n>\n> b|", "> a\n>\n> b\n> |"],
  ])("continues %j", (input, expected) => {
    expect(run(continueMarkup, input)).toBe(expected);
  });

  it.each([
    ["- item\n- |", "- item\n|"],
    ["1. a\n2. |", "1. a\n|"],
    ["- [ ] a\n- [ ] |", "- [ ] a\n|"],
    ["> - a\n> - |", "> - a\n> |"],
  ])("ends the list on an empty item %j", (input, expected) => {
    expect(run(continueMarkup, input)).toBe(expected);
  });

  it("outdents an empty nested item", () => {
    expect(run(continueMarkup, "- a\n\t- |")).toBe("- a\n- |");
  });

  it.each([
    ["> a\n> |", "> a\n\n|"],
    ["> > a\n> > |", "> > a\n> \n> |"],
  ])("leaves one quote level on an empty quote line %j", (input, expected) => {
    expect(run(continueMarkup, input)).toBe(expected);
  });

  it.each([
    ["1. one|\n2. two", "1. one\n2. |\n3. two"],
    ["1. a\n2. b|\n3. c\n4. d", "1. a\n2. b\n3. |\n4. c\n5. d"],
  ])("renumbers the rest of an ordered list %j", (input, expected) => {
    expect(run(continueMarkup, input)).toBe(expected);
  });

  it.each([
    ["|- item", "\n|- item"],
    ["-| item", "-\n|item"],
    ["# Ti|tle", "# Ti\n|tle"],
    ["# Title|", "# Title\n|"],
    ["\tword|", "\tword\n\t|"],
    ["  word|", "  word\n  |"],
  ])("breaks plain lines keeping indentation %j", (input, expected) => {
    expect(run(continueMarkup, input)).toBe(expected);
  });

  it("replaces a selection with a plain line break", () => {
    expect(run(continueMarkup, "- a«bc»d")).toBe("- a\n|d");
  });

  it.each([
    ["```\n- a|\n```", "```\n- a\n  |\n```"],
    ["```\n\tfoo|\n```", "```\n\tfoo\n\t|\n```"],
  ])("only aligns lines inside fenced code %j", (input, expected) => {
    expect(run(continueMarkup, input)).toBe(expected);
  });
});

describe("continueMarkupSoft (Shift-Enter)", () => {
  it.each([
    ["- item|", "- item\n  |"],
    ["- [ ] a|", "- [ ] a\n      |"],
    ["10. a|", "10. a\n    |"],
    ["> q|", "> q\n> |"],
    ["a|", "a\n|"],
  ])("%j", (input, expected) => {
    expect(run(continueMarkupSoft, input)).toBe(expected);
  });
});

describe("indentListMore / indentListLess (Tab / Shift-Tab)", () => {
  it.each([
    ["- a\n- b|", "- a\n\t- b|"],
    ["- a\n- b|c", "- a\n\t- b|c"],
    ["- a|", "\t- a|"],
    ["word|", "\tword|"],
    ["ab|cd", "\tab|cd"],
    ["«a\nb»", "\t«a\n\tb»"],
    ["1. a\n2. b|", "1. a\n\t1. b|"],
    ["1. a\n2. b\n3. c|\n4. d", "1. a\n2. b\n\t1. c|\n3. d"],
  ])("indents %j", (input, expected) => {
    expect(run(indentListMore, input)).toBe(expected);
  });

  it.each([
    ["- a\n\t- b|", "- a\n- b|"],
    ["\tword|", "word|"],
    ["1. a\n\t1. b|", "1. a\n2. b|"],
    ["1. a\n\t1. b|\n\t2. c\n2. d", "1. a\n2. b|\n\t1. c\n3. d"],
  ])("outdents %j", (input, expected) => {
    expect(run(indentListLess, input)).toBe(expected);
  });
});

describe("lineStartAfterMarkup (Home)", () => {
  const home = (spec: string) => {
    const state = stateFor(spec);
    return lineStartAfterMarkup(state, state.selection.main.head);
  };

  it.each([
    ["- item te|xt", 2],
    ["- [ ] te|xt", 6],
    ["> te|xt", 2],
    ["12. te|xt", 4],
  ])("stops after the markup of %j", (input, expected) => {
    expect(home(input)).toBe(expected);
  });

  it.each([["## te|xt"], ["- |text"], ["|- text"], ["plain te|xt"]])(
    "defers to the line start for %j",
    (input) => {
      expect(home(input)).toBeNull();
    },
  );
});

describe("toggleInlineMark", () => {
  const bold = toggleInlineMark("**");
  const italic = toggleInlineMark("*");

  it.each([
    ["a wo|rd b", "a **wo|rd** b"],
    ["a word| b", "a **word**| b"],
    ["a |", "a **|**"],
    ["a «word» b", "a **«word»** b"],
    ["a w«or»d b", "a w**«or»**d b"],
    ["«a b»", "**«a b»**"],
    ["a **wo|rd** b", "a wo|rd b"],
    ["a **«word»** b", "a «word» b"],
    ["a «**word**» b", "a «word» b"],
  ])("bold %j", (input, expected) => {
    expect(run(bold, input)).toBe(expected);
  });

  it.each([
    ["a «word» b", "a *«word»* b"],
    ["a wo|rd b", "a *wo|rd* b"],
    ["a *wo|rd* b", "a wo|rd b"],
    ["a **«word»** b", "a ***«word»*** b"],
  ])("italic %j", (input, expected) => {
    expect(run(italic, input)).toBe(expected);
  });
});

describe("toggleComment", () => {
  it.each([
    ["a «word» b", "a %%«word»%% b"],
    ["a wo|rd", "a %%«word»%%"],
    ["a |", "a %%|%%"],
    ["a %%«word»%% b", "a «word» b"],
  ])("%j", (input, expected) => {
    expect(run(toggleComment, input)).toBe(expected);
  });
});

describe("insertMarkdownLink", () => {
  it.each([
    ["see «docs»", "see [docs](|)"],
    ["see |", "see [|]()"],
    ["«a b»", "[a b](|)"],
  ])("%j", (input, expected) => {
    expect(run(insertMarkdownLink, input)).toBe(expected);
  });
});

describe("toggleChecklist", () => {
  it.each([
    ["text|", "- [ ] text|"],
    ["|", "- [ ] |"],
    ["- [ ] text|", "- [x] text|"],
    ["- [x] text|", "- [ ] text|"],
    ["- text|", "- [ ] text|"],
    ["1. text|", "1. [ ] text|"],
    ["1. [ ] a|", "1. [x] a|"],
    ["\t- a|", "\t- [ ] a|"],
    ["# text|", "- [ ] # text|"],
    ["> text|", "> - [ ] text|"],
    ["«a\nb»", "- [ ] «a\n- [ ] b»"],
  ])("%j", (input, expected) => {
    expect(run(toggleChecklist, input)).toBe(expected);
  });
});

describe("deleteParagraph (Mod-D)", () => {
  it.each([
    ["one\ntw|o\nthree", "one\nth|ree"],
    ["«one\ntw»o\nthree", "th|ree"],
    ["one\ntw|o", "one|"],
    ["on|ly", "|"],
    ["a\nlong|er line\nb", "a\nb|"],
  ])("%j", (input, expected) => {
    expect(run(deleteParagraph, input)).toBe(expected);
  });
});
