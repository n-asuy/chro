import {
  SessionDirectoryProvider,
  createSessionDirectory,
} from "@/session/context/session-directory-context";
import { sessionMentionLabel } from "@/session/lib/session-label";
import type { StoredTask } from "@/session/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../markdown";

/**
 * Static render only: what matters is which text becomes a session reference
 * and what it reads as. Hover and click are wired to the shared preview panel
 * and the layout, and are exercised through the app.
 */
const task = (slug: string, title: string): StoredTask => ({
  id: `id-${slug}`,
  slug,
  project_id: "project-1",
  title,
  status: "completed",
  created_at: "2026-11-07T00:00:00Z",
  updated_at: "2026-11-07T00:00:00Z",
  sort_order: 0,
  last_executor: "CLAUDE_CODE",
});

const directory = createSessionDirectory();
directory.update(
  [task("20CFfEXi", "Allo と Fin の機能対照表を作る"), task("abcdefgh", "x")],
  () => {},
);

function render(source: string, withDirectory = true): string {
  const markdown = <Markdown>{source}</Markdown>;
  return renderToStaticMarkup(
    withDirectory ? (
      <SessionDirectoryProvider value={directory}>
        {markdown}
      </SessionDirectoryProvider>
    ) : (
      markdown
    ),
  );
}

const mentions = (markup: string): string[] =>
  Array.from(
    markup.matchAll(/data-session-mention="([^"]*)"[^>]*>(.*?)<\/span>/g),
    (match) => match[1] ?? "",
  );

describe("session mentions in agent prose", () => {
  it("shows a known session slug as its title instead of the id", () => {
    const markup = render("20CFfEXi に作らせている機能の対照表で確かめます。");

    expect(mentions(markup)).toEqual(["id-20CFfEXi"]);
    expect(markup).toContain("Allo と Fin の機能対照表を作る");
    expect(markup).not.toContain(">20CFfEXi<");
  });

  it("recognises a slug written in a code span", () => {
    const markup = render("委譲先は `20CFfEXi` です");

    expect(mentions(markup)).toEqual(["id-20CFfEXi"]);
  });

  it("leaves an eight-character word that names no session as plain text", () => {
    const markup = render("Markdown rendering of 9zzzzzzQ stays put");

    expect(mentions(markup)).toEqual([]);
    expect(markup).toContain("Markdown rendering of 9zzzzzzQ stays put");
  });

  it("does not touch a slug-shaped segment inside a path or URL", () => {
    const markup = render(
      "see /tmp/20CFfEXi/out.png and https://example.com/20CFfEXi",
    );

    expect(mentions(markup)).toEqual([]);
  });

  it("does not nest a mention inside a link the agent wrote", () => {
    const markup = render("[20CFfEXi](https://example.com)");

    expect(mentions(markup)).toEqual([]);
  });

  it("renders plain text where no session directory is provided", () => {
    const markup = render("20CFfEXi に作らせている", false);

    expect(mentions(markup)).toEqual([]);
    expect(markup).toContain("20CFfEXi に作らせている");
  });
});

describe("sessionMentionLabel", () => {
  it("keeps a short title whole", () => {
    expect(sessionMentionLabel("受信箱の案", "20CFfEXi")).toBe("受信箱の案");
  });

  it("cuts a long title to its opening words", () => {
    const label = sessionMentionLabel(
      "スマホ通話アプリの画面モックと機能対照表を Allo と Fin から作る",
      "20CFfEXi",
    );

    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(25);
    expect(label.startsWith("スマホ通話アプリの画面モック")).toBe(true);
  });

  it("falls back to the slug for an untitled session", () => {
    expect(sessionMentionLabel("  ", "20CFfEXi")).toBe("20CFfEXi");
  });
});
