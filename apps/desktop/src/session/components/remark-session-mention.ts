/**
 * Remark plugin that marks every word shaped like a session slug.
 *
 * Agents refer to sessions by the eight-character base62 slug the `chro` CLI
 * prints (`20CFfEXi`). Whether a word actually names a session is only known
 * at render time, against the live session list, so the plugin marks the
 * candidates and the renderer decides: a word that names no session renders
 * as the text it was.
 */

import type { Parent, PhrasingContent, Root, Text } from "mdast";
import { SKIP, visit } from "unist-util-visit";

export const SESSION_MENTION_SLUG_ATTRIBUTE = "data-session-slug";

/** A slug standing on its own: not part of a longer word, a path segment, a
 * hyphenated name or a file name. A sentence-ending period is allowed. */
const SLUG_PATTERN = /(?<![\w./\\-])[0-9A-Za-z]{8}(?![\w/\\-]|\.\w)/g;

const SLUG_SHAPE = /^[0-9A-Za-z]{8}$/;

/** Text inside these already links somewhere; a mention there would nest. */
const LINK_PARENTS = new Set(["link", "linkReference", "wikilink"]);

export const isSessionSlugShaped = (text: string): boolean =>
  SLUG_SHAPE.test(text);

interface SessionMentionNode {
  type: "sessionMention";
  data: {
    hName: "span";
    hProperties: { [SESSION_MENTION_SLUG_ATTRIBUTE]: string };
  };
  children: [Text];
}

function splitTextWithSlugs(text: string): Array<Text | SessionMentionNode> {
  const result: Array<Text | SessionMentionNode> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(SLUG_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      result.push({ type: "text", value: text.slice(lastIndex, index) });
    }
    result.push({
      type: "sessionMention",
      data: {
        hName: "span",
        hProperties: { [SESSION_MENTION_SLUG_ATTRIBUTE]: match[0] },
      },
      children: [{ type: "text", value: match[0] }],
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push({ type: "text", value: text.slice(lastIndex) });
  }
  return result;
}

export function remarkSessionMention() {
  return (tree: Root) => {
    visit(tree, (node, index, parent: Parent | undefined) => {
      if (LINK_PARENTS.has(node.type)) return SKIP;
      if (node.type !== "text" || !parent || typeof index !== "number") {
        return undefined;
      }

      const parts = splitTextWithSlugs((node as Text).value);
      if (parts.length === 1 && parts[0]?.type === "text") return undefined;

      parent.children.splice(
        index,
        1,
        ...(parts as unknown as PhrasingContent[]),
      );
      // Continue after the inserted nodes; the mention's own text must not be
      // visited again.
      return [SKIP, index + parts.length] as const;
    });
  };
}
