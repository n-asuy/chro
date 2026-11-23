// @vitest-environment jsdom
import { LanguageProvider } from "@/i18n";
import type { DisplayEntry } from "@/session/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationDensity } from "../conversation-density";
import { TaskConversation } from "../task-conversation";

const entry = (id: string, type: string, content: string) =>
  ({
    type: "NORMALIZED_ENTRY",
    key: `run:${id}`,
    content: { timestamp: null, entry_type: { type }, content },
  }) as unknown as DisplayEntry;

const entries = [
  entry("1", "user_message", "Add the branch"),
  entry("2", "system_message", "Run with opus"),
  entry("3", "assistant_message", "# Done\n\n- one\n\n| a |\n| - |\n| b |"),
];

function render(density?: ConversationDensity): Document {
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <LanguageProvider>
        <TaskConversation
          entries={entries}
          isLoading={false}
          error={null}
          density={density}
        />
      </LanguageProvider>
    </QueryClientProvider>,
  );
  return new DOMParser().parseFromString(markup, "text/html");
}

const classesOf = (doc: Document, text: string) => {
  const leaf = [...doc.querySelectorAll("*")].find(
    (node) => node.children.length === 0 && node.textContent === text,
  );
  const classes: string[] = [];
  for (let node = leaf; node; node = node.parentElement ?? undefined) {
    classes.push(...node.classList);
  }
  return classes;
};

describe("conversation density", () => {
  it("is the session window's unless said otherwise", () => {
    const doc = render();
    expect(classesOf(doc, "Add the branch")).toEqual(
      expect.arrayContaining(["text-sm", "leading-relaxed", "px-4", "px-6"]),
    );
    expect(doc.body.innerHTML).toBe(render("regular").body.innerHTML);
  });

  it("sets a compact conversation's text in 13px on 20px", () => {
    const doc = render("compact");
    for (const text of ["Add the branch", "one"]) {
      const classes = classesOf(doc, text);
      expect(classes).toEqual(
        expect.arrayContaining(["text-[13px]", "leading-5"]),
      );
      expect(classes).not.toContain("text-sm");
    }
  });

  it("starts compact replies at the request bubble's left edge", () => {
    const doc = render("compact");
    const insets = (text: string) =>
      classesOf(doc, text).filter((name) => /^(px|pl|ps)-/.test(name));
    // The bubble's own padding, then the viewport's; a reply has only that.
    expect(insets("Add the branch")).toEqual(["px-[11px]", "pl-3.5"]);
    expect(insets("Done")).toEqual(["pl-3.5"]);
    expect(insets("Run with")).toEqual(["pl-3.5"]);
  });

  it("keeps a compact message's actions out of the 12px between blocks", () => {
    const row =
      render("compact").querySelector("button[aria-label]")?.parentElement
        ?.className;
    expect(row).toContain("absolute");
  });
});
