/**
 * Hashtag decoration plugin
 * Adds styling to #hashtag elements
 */

import { Decoration } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range as EditorRange } from "@codemirror/state";
import { decorationProseHashtag } from "../../utility/decorations";
import { createProsePlugin } from "./create-prose-plugin";

function buildHashtagWrappers(state: EditorState): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "HashtagTag") {
        decorations.push(decorationProseHashtag.range(node.from, node.to));
      }
    },
  });
  return decorations;
}

export const hashtagPlugin = createProsePlugin({
  buildDecorations: buildHashtagWrappers,
  rebuildOnDocChange: true,
  rebuildOnSelection: false,
});
