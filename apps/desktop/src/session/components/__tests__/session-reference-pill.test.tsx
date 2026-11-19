import { LanguageProvider } from "@/i18n";
import {
  SessionDirectoryProvider,
  createSessionDirectory,
} from "@/session/context/session-directory-context";
import type { StoredTask } from "@/session/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserMessageContent } from "../../conversation-view";
import { formatContextForPrompt } from "../../types/context";

/**
 * Static render: a session the user referenced reads as that session's title,
 * cut the same way a session named in agent prose is, not as its id.
 */
const TASK_ID = "79d441b9-0000-4000-8000-000000000000";

const task = (title: string): StoredTask => ({
  id: TASK_ID,
  slug: "20CFfEXi",
  project_id: "project-1",
  title,
  status: "completed",
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
  sort_order: 0,
  last_executor: "CLAUDE_CODE",
});

const content = `${formatContextForPrompt([
  { kind: "session", taskId: TASK_ID },
])}\nこれを参考にして`;

function render(tasks: StoredTask[] | null): string {
  const message = (
    <LanguageProvider>
      <UserMessageContent content={content} />
    </LanguageProvider>
  );
  if (!tasks) return renderToStaticMarkup(message);
  const directory = createSessionDirectory();
  directory.update(tasks, () => {});
  return renderToStaticMarkup(
    <SessionDirectoryProvider value={directory}>
      {message}
    </SessionDirectoryProvider>,
  );
}

describe("session reference pill in a user message", () => {
  it("shows the referenced session's title instead of its id", () => {
    const html = render([task("受信箱の案")]);

    expect(html).toContain("受信箱の案");
    expect(html).not.toContain(">79d441b9<");
  });

  it("cuts a long title to its opening, like a mention in prose", () => {
    const html = render([
      task("スマホ通話アプリの画面モックと機能対照表を Allo と Fin から作る"),
    ]);

    expect(html).toContain("スマホ通話アプリの画面モック");
    expect(html).toContain("…");
    expect(html).not.toContain("機能対照表を Allo と Fin から作る");
  });

  it("falls back to the short id when the session is unknown", () => {
    expect(render([])).toContain("79d441b9");
    expect(render(null)).toContain("79d441b9");
  });
});
