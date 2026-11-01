import { LanguageProvider } from "@/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserMessageContent } from "../../conversation-view";
import { formatContextForPrompt } from "../../types/context";

/**
 * Static render: how a sent message that carries page annotations reads in
 * the conversation. The comments are the substance of the request, so they
 * are shown in full rather than collapsed into a pill.
 */
function render(content: string): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <UserMessageContent content={content} />
    </LanguageProvider>,
  );
}

const content = `${formatContextForPrompt([
  { kind: "file", path: "src/theme.css", isFile: true },
  {
    kind: "annotations",
    path: "site/pricing.html",
    viewport: { width: 1280, height: 800 },
    notes: [
      {
        selector: "section.plans > button",
        element: 'button "Start trial"',
        rect: { x: 1, y: 2, width: 3, height: 4 },
        comment: "Use the primary color",
      },
      {
        selector: "#hero > h1",
        element: "h1",
        rect: { x: 0, y: 0, width: 9, height: 9 },
        comment: "Keep it on one line",
      },
    ],
  },
])}\nFix these`;

describe("UserMessageContent with page annotations", () => {
  it("shows every comment with the element it was pinned on", () => {
    const html = render(content);
    expect(html).toContain("2 notes on pricing.html");
    expect(html).toContain("Use the primary color");
    expect(html).toContain("Keep it on one line");
    expect(html).toContain("section.plans &gt; button");
    expect(html).toContain("Fix these");
  });

  it("keeps file references as pills and does not repeat the page as one", () => {
    const html = render(content);
    expect(html).toContain('title="src/theme.css"');
    // One reference pill (the stylesheet); the page itself is the card.
    expect(html.match(/rounded bg-blue-50 px-1\.5/g)).toHaveLength(1);
    expect(html).not.toContain("&lt;page_annotations");
  });
});
