import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeFilePathHref } from "../file-path-utils";
import { Markdown } from "../markdown";

/**
 * Static render only: what matters here is the block structure remark hands to
 * the renderers, not interaction. Agent output is chat prose, so a newline the
 * agent typed has to survive as a newline the reader sees.
 */
function render(source: string): string {
  return renderToStaticMarkup(<Markdown>{source}</Markdown>);
}

const countBreaks = (markup: string): number =>
  markup.match(/<br\b/g)?.length ?? 0;

describe("Markdown line breaks", () => {
  it("renders a single newline inside a paragraph as a line break", () => {
    const markup = render("一行目\n二行目");

    expect(countBreaks(markup)).toBe(1);
    expect(markup).not.toContain("一行目 二行目");
  });

  it("keeps each line of a bullet block inside a blockquote on its own line", () => {
    const markup = render(
      [
        "> お疲れ様です。以下について確認させてください。",
        "> ・A案/B案の方向感",
        "> ・初期構築の構成のご説明",
        "> ・3点のご回答の確認",
        "> 以上よろしくお願いします。",
      ].join("\n"),
    );

    expect(countBreaks(markup)).toBe(4);
  });

  it("leaves newlines inside fenced code blocks untouched", () => {
    const markup = render(
      ["```", "const a = 1;", "const b = 2;", "```"].join("\n"),
    );

    expect(countBreaks(markup)).toBe(0);
    expect(markup).toContain("const a = 1;\nconst b = 2;");
  });

  it("separates blank-line paragraphs even when nested in a blockquote", () => {
    const markup = render("> 前段です。\n>\n> 後段です。");

    const paragraphs = markup.match(/<p class="[^"]*"/g) ?? [];
    expect(paragraphs).toHaveLength(2);
    // A blank line has to read as more than the single-newline break above it.
    expect(paragraphs[1]).toContain("mt-3");
  });
});

describe("Markdown web addresses", () => {
  const renderWithHandlers = (source: string): string => render(source);

  it("turns a web address written in a code span into a link to the browser", () => {
    const markup = renderWithHandlers("`chro-ai.com` のゾーン");

    expect(markup).toContain('title="https://chro-ai.com"');
    expect(markup).toContain('role="link"');
  });

  it("gives an interactive code span a link color that nothing else overrides", () => {
    // `text-foreground` and `text-blue-600` are the same utility: whichever
    // lands later in the stylesheet wins, regardless of authoring order. An
    // interactive span must therefore carry only the link color.
    const markup = renderWithHandlers("`chro-ai.com` のゾーン");
    const interactive = markup.match(/<code class="([^"]*)"[^>]*role="link"/);

    expect(interactive?.[1]).toContain("text-blue-600");
    expect(interactive?.[1]).not.toContain("text-foreground");
  });

  it("keeps a file name that ends in a TLD-shaped extension out of the browser", () => {
    // `README.md` also parses as `<host>.<tld>`; it stays a file.
    const markup = renderWithHandlers("`README.md` を読んでください");

    expect(markup).not.toContain("title=");
    expect(markup).not.toContain("href=");
  });

  it("opens a link destination written without a scheme", () => {
    const markup = renderWithHandlers("[配布](chro-ai.com)");

    expect(markup).toContain('href="https://chro-ai.com"');
    expect(markup).toContain('target="_blank"');
  });
});

describe("Markdown local path links", () => {
  // Path references become links only once the server confirms they exist (see
  // path-link.test.ts). Unresolved — which is every reference on a first,
  // synchronous render — they must stay as the text the agent wrote, so a link
  // is never shown for something a click cannot open.
  it("leaves an unresolved path reference as plain text", () => {
    const markup = render("[Open today](/Users/alice/Desktop/today)");

    expect(markup).not.toContain('role="link"');
    expect(markup).not.toContain("href=");
    expect(markup).toContain("Open today");
  });

  it("leaves an unresolved code span path as plain text", () => {
    const markup = render("`src/session/components/markdown.tsx`");

    expect(markup).not.toContain('role="link"');
  });

  it("decodes escaped path characters before opening a local link", () => {
    expect(normalizeFilePathHref("/Users/alice/My%20Folder")).toBe(
      "/Users/alice/My Folder",
    );
  });
});
