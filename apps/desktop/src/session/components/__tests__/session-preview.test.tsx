import { LanguageProvider } from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewConversation } from "../session-preview";

/**
 * Static render only: this checks what the hover panel shows for a given turn
 * list and exchange — the rail rows, which turn reads as selected, and the
 * detail pane's content. Hover/click selection is timer-driven and exercised
 * through the app.
 */
function render(
  props: Partial<Parameters<typeof PreviewConversation>[0]>,
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <LanguageProvider>
        <PreviewConversation
          taskId="task-1"
          turns={null}
          latestExchange={null}
          latestLoading={false}
          latestError={false}
          pendingQuestion={null}
          {...props}
        />
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

const turns = [
  {
    sessionId: "s-2",
    user: "second prompt preview",
    createdAt: new Date().toISOString(),
  },
  {
    sessionId: "s-1",
    user: "first prompt preview",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  },
];

describe("PreviewConversation", () => {
  it("renders the history rail with every turn and the latest exchange", () => {
    const html = render({
      turns,
      latestExchange: { user: "second prompt", assistant: "second reply" },
    });

    expect(html).toContain("second prompt preview");
    expect(html).toContain("first prompt preview");
    expect(html).toContain("second prompt");
    expect(html).toContain("second reply");
  });

  it("marks the newest turn as selected by default", () => {
    const html = render({
      turns,
      latestExchange: { user: "second prompt", assistant: "second reply" },
    });

    // The selected row carries the sidebar-background highlight; exactly one
    // row (the newest turn) should.
    const highlighted = html.match(/bg-custom-sidebar-background-80/g) ?? [];
    // One for the selected rail row, one for the user-message bubble.
    expect(highlighted.length).toBe(2);
    const railRow = html.indexOf("second prompt preview");
    const olderRow = html.indexOf("first prompt preview");
    const firstHighlight = html.indexOf("bg-custom-sidebar-background-80");
    expect(firstHighlight).toBeLessThan(railRow);
    expect(firstHighlight).toBeLessThan(olderRow);
  });

  it("renders no rail for a single-turn task", () => {
    const html = render({
      turns: null,
      latestExchange: { user: "only prompt", assistant: "only reply" },
    });

    expect(html).toContain("only prompt");
    expect(html).toContain("only reply");
    expect(html).not.toContain("border-r");
  });

  it("shows the pending question alongside the latest exchange", () => {
    const html = render({
      turns,
      latestExchange: { user: "second prompt", assistant: null },
      pendingQuestion: "Which option should I take?",
    });

    expect(html).toContain("Which option should I take?");
  });
});

describe("PreviewConversation loading rail", () => {
  it("reserves the rail with a spinner while the turn list loads", () => {
    const html = render({
      turns: null,
      turnsLoading: true,
      latestExchange: { user: "prompt", assistant: "reply" },
    });

    expect(html).toContain("animate-spin");
    expect(html).toContain("border-r");
  });

  it("shows no rail once loading settles on a single-turn task", () => {
    const html = render({
      turns: null,
      turnsLoading: false,
      latestExchange: { user: "prompt", assistant: "reply" },
    });

    expect(html).not.toContain("border-r");
  });
});
