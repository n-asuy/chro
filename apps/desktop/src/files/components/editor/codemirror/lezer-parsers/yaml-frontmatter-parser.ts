/**
 * YAML frontmatter parser for document metadata
 * Based on lezer-markdown-obsidian
 */

import type { MarkdownConfig, BlockContext, Line } from "@lezer/markdown";
import { Tag } from "@lezer/highlight";

export const lezerHighlightYamlFrontmatter = Tag.define("YAMLFrontMatter");
export const lezerHighlightYamlMarker = Tag.define(
  "YAMLMarker",
  lezerHighlightYamlFrontmatter,
);
export const lezerHighlightYamlContent = Tag.define(
  "YAMLContent",
  lezerHighlightYamlFrontmatter,
);

interface ExtendedBlockContext extends BlockContext {
  checkedYaml?: boolean | null;
}

export const yamlFrontmatterParser: MarkdownConfig = {
  defineNodes: [
    { name: "YAMLFrontMatter", style: lezerHighlightYamlFrontmatter },
    { name: "YAMLMarker", style: lezerHighlightYamlMarker },
    { name: "YAMLContent", style: lezerHighlightYamlContent },
  ],
  parseBlock: [
    {
      name: "YAMLFrontMatter",
      parse(cx: BlockContext, line: Line) {
        const extCx = cx as ExtendedBlockContext;

        // Ensure checkedYaml exists on cx
        if (!Object.prototype.hasOwnProperty.call(extCx, "checkedYaml")) {
          extCx.checkedYaml = null;
        }

        if (extCx.checkedYaml || cx.lineStart !== 0) {
          return false;
        }
        extCx.checkedYaml = true;

        // Check for opening '---'
        if (line.text.slice(line.pos) !== "---") {
          return false;
        }

        const start = cx.lineStart + line.pos;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const markers: any[] = [cx.elt("YAMLMarker", start, start + 3)];
        let contentStart = -1;
        let contentEnd = -1;
        let end = -1;

        // Read lines until closing '---' or '...'
        while (cx.nextLine()) {
          if (contentStart === -1) contentStart = cx.lineStart;

          const lineText = line.text.slice(line.pos);
          if (lineText === "---" || lineText === "...") {
            contentEnd = cx.lineStart - 1;
            if (contentStart > contentEnd && contentStart !== -1)
              contentEnd = contentStart;

            end = cx.lineStart + line.pos + 3;
            markers.push(cx.elt("YAMLMarker", cx.lineStart + line.pos, end));
            cx.nextLine();
            break;
          }
        }

        if (end === -1) return false;

        if (
          contentStart !== -1 &&
          contentEnd !== -1 &&
          contentStart <= contentEnd
        ) {
          markers.splice(1, 0, cx.elt("YAMLContent", contentStart, contentEnd));
        }

        cx.addElement(cx.elt("YAMLFrontMatter", start, end, markers));
        return true;
      },
      before: "LinkReference",
    },
  ],
};
