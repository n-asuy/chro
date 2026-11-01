import { LanguageProvider } from "@/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionQueueList } from "../session-queue-list";

/**
 * Static render: what the composer shows for a session's queue. Messages are
 * queued from the composer, the terminal or by agents; the list reorders,
 * edits, sends now and withdraws them.
 */
function render(prompts: string[]): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <SessionQueueList
        items={prompts.map((prompt, index) => ({
          id: `q${index}`,
          task_id: "t1",
          prompt,
          seq: index + 1,
          created_at: "2026-10-25 01:00:00.000",
        }))}
        onWithdraw={() => {}}
        onEdit={async () => {}}
        onReorder={async () => {}}
        onSendNow={async () => {}}
      />
    </LanguageProvider>,
  );
}

describe("SessionQueueList", () => {
  it("renders nothing while nothing is queued", () => {
    expect(render([])).toBe("");
  });

  it("shows every waiting message with a way to withdraw it", () => {
    const html = render(["Also cover logout", "Then run the tests"]);
    expect(html).toContain("Also cover logout");
    expect(html).toContain("Then run the tests");
    expect(html.match(/aria-label="Remove"/g)).toHaveLength(2);
  });

  it("shows what was written, with a count of attached images", () => {
    const html = render(["![red.png](.chro-context/a.png)Describe the image"]);
    expect(html).toContain("Describe the image");
    expect(html).not.toContain(".chro-context");
    expect(html).toMatch(/<svg[^>]*lucide-image[^>]*>[\s\S]*?<\/svg>1</);
  });

  it("offers to reorder, edit and send each message now", () => {
    const html = render(["Also cover logout", "Then run the tests"]);
    expect(html.match(/aria-label="Drag to reorder"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Edit"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Send now"/g)).toHaveLength(2);
  });
});
