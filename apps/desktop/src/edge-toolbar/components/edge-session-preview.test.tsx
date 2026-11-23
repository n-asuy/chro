import type { StoredTask } from "@/session/types";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  markViewedWhenActive: vi.fn(),
  fetch: vi.fn(),
}));

// What the preview reads: one finished turn (request, a tool call, reply).
vi.mock("../hooks/use-edge-conversation", () => ({
  useEdgeConversation: () => ({
    isLoading: false,
    entries: [
      { type: "USER_MESSAGE", content: "Fix the login bug" },
      { type: "ASSISTANT_MESSAGE", content: "Fixed it." },
    ],
  }),
}));
vi.mock("@/workspace-layout/hooks/use-all-projects", () => ({
  useAllProjects: () => ({ p1: { id: "p1", name: "repo" } }),
}));
// The hook the session panel uses to mark a session read when it is shown.
vi.mock("@/session/hooks/use-session-read-state", () => ({
  useMarkViewedWhenActive: mocks.markViewedWhenActive,
  useSessionReadSync: () => {},
}));

import { LanguageProvider } from "@/i18n";
import { useSessionReadStore } from "@/session/state/session-read-store";
import { EdgeSessionPreview } from "./edge-session-list";

const task: StoredTask = {
  id: "t1",
  project_id: "p1",
  title: "Login bug",
  status: "completed",
  created_at: "2026-11-23T09:00:00.000Z",
  updated_at: "2026-11-23T10:00:00.000Z",
  sort_order: 0,
  last_executor: "CLAUDE_CODE",
};

describe("the session preview (row hover and tile hover)", () => {
  beforeEach(() => {
    mocks.markViewedWhenActive.mockReset();
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
    useSessionReadStore.setState({ viewedAt: {} });
  });

  it("shows the session without marking it read or writing anything", () => {
    const markup = renderToStaticMarkup(
      <LanguageProvider>
        <EdgeSessionPreview task={task} status="done" />
      </LanguageProvider>,
    );
    expect(markup).toContain("Login bug");
    expect(mocks.markViewedWhenActive).not.toHaveBeenCalled();
    expect(useSessionReadStore.getState().viewedAt).toEqual({});
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
