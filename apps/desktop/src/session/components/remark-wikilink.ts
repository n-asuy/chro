/**
 * Remark plugin for Obsidian-style wikilinks
 *
 * Obsidian wikilink syntax:
 * - [[page]] - link to page
 * - [[page|display text]] - link with custom display text
 * - [[page#heading]] - link to heading
 * - [[page#heading|display text]] - link to heading with display text
 * - [[#heading]] - link to heading in current file
 *
 * This plugin transforms wikilinks into custom nodes that can be rendered as clickable links.
 */

import type { PhrasingContent, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

interface WikilinkNode {
  type: "wikilink";
  data: {
    hName: "span";
    hProperties: {
      className: string[];
      "data-wikilink-path": string;
      "data-wikilink-subpath"?: string;
    };
  };
  children: Array<{ type: "text"; value: string }>;
  value: string;
  path: string;
  subpath?: string;
  displayText: string;
}

// Regex to match wikilinks: [[path#subpath|display]] or [[path|display]] or [[path#subpath]] or [[path]]
const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

function parseWikilink(match: RegExpExecArray): WikilinkNode {
  const fullMatch = match[0];
  const path = match[1]?.trim() ?? "";
  const subpath = match[2]?.trim();
  const displayText =
    match[3]?.trim() ?? (subpath ? `${path}#${subpath}` : path);

  return {
    type: "wikilink",
    data: {
      hName: "span",
      hProperties: {
        className: ["wikilink"],
        "data-wikilink-path": path,
        ...(subpath ? { "data-wikilink-subpath": subpath } : {}),
      },
    },
    children: [{ type: "text", value: displayText }],
    value: fullMatch,
    path,
    subpath,
    displayText,
  };
}

function splitTextWithWikilinks(text: string): Array<Text | WikilinkNode> {
  const result: Array<Text | WikilinkNode> = [];
  let lastIndex = 0;

  WIKILINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = WIKILINK_PATTERN.exec(text)) !== null) {
    // Add text before the wikilink
    if (match.index > lastIndex) {
      result.push({
        type: "text",
        value: text.slice(lastIndex, match.index),
      });
    }

    // Add the wikilink node
    result.push(parseWikilink(match));

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after the last wikilink
  if (lastIndex < text.length) {
    result.push({
      type: "text",
      value: text.slice(lastIndex),
    });
  }

  return result;
}

export function remarkWikilink() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || typeof index !== "number") return;

      // Skip if no wikilinks in this text node
      if (!node.value.includes("[[")) return;

      const newNodes = splitTextWithWikilinks(node.value);

      // If we only have one node and it's the same text, no changes needed
      if (newNodes.length === 1 && newNodes[0]?.type === "text") return;

      // Replace the text node with the new nodes
      parent.children.splice(
        index,
        1,
        ...(newNodes as unknown as PhrasingContent[]),
      );
    });
  };
}
