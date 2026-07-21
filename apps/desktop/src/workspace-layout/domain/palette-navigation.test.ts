import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_MAX,
  type BuildPaletteSectionsInput,
  PROJECT_RESULTS_MAX,
  RECENT_MAX,
  SESSION_RESULTS_MAX,
  buildPaletteSections,
} from "./palette-navigation";

function task(id: string, over: Partial<StoredTask> = {}): StoredTask {
  return {
    id,
    project_id: "p1",
    title: `Session ${id}`,
    status: "completed",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-19T00:00:00Z",
    sort_order: 0,
    ...over,
  };
}

function build(over: Partial<BuildPaletteSectionsInput> = {}) {
  return buildPaletteSections({
    query: "",
    commands: [{ id: "new-chat", label: "New chat" }],
    sessions: [],
    projects: [],
    projectNameOf: () => null,
    lastViewedAtOf: () => null,
    ...over,
  });
}

function section(sections: ReturnType<typeof build>, id: string) {
  return sections.find((s) => s.id === id);
}

function sessionIds(sections: ReturnType<typeof build>, id: string): string[] {
  return (section(sections, id)?.items ?? []).flatMap((item) =>
    item.kind === "session" ? [item.task.id] : [],
  );
}

describe("buildPaletteSections — browsing (empty query)", () => {
  it("lists commands, then attention, then recent", () => {
    const sections = build({
      sessions: [
        task("a", { awaiting_input: true, active_session_id: "s" }),
        task("b"),
      ],
      lastViewedAtOf: () => "2026-07-20T00:00:00Z",
    });
    expect(sections.map((s) => s.id)).toEqual([
      "commands",
      "attention",
      "recent",
    ]);
    expect(section(sections, "commands")?.items).toEqual([
      { kind: "command", commandId: "new-chat" },
    ]);
  });

  it("treats a whitespace-only query as browsing", () => {
    const sections = build({ query: "   ", sessions: [task("a")] });
    expect(section(sections, "recent")).toBeDefined();
    expect(section(sections, "sessions")).toBeUndefined();
  });

  it("puts awaiting-input sessions before unread failures in attention", () => {
    const sections = build({
      sessions: [
        task("failed", { status: "failed" }),
        task("blocked", { awaiting_input: true, active_session_id: "s" }),
      ],
      lastViewedAtOf: () => null,
    });
    expect(sessionIds(sections, "attention")).toEqual(["blocked", "failed"]);
    const items = section(sections, "attention")?.items ?? [];
    expect(items.map((i) => (i.kind === "session" ? i.flag : null))).toEqual([
      "needs_input",
      "failed",
    ]);
  });

  it("excludes viewed failures from attention", () => {
    const sections = build({
      sessions: [task("failed", { status: "failed" })],
      lastViewedAtOf: () => "2026-07-19T01:00:00Z", // after updated_at
    });
    expect(section(sections, "attention")).toBeUndefined();
    expect(sessionIds(sections, "recent")).toEqual(["failed"]);
  });

  it("does not flag a running session even when its stored status is failed", () => {
    const sections = build({
      sessions: [task("rerun", { status: "failed", active_session_id: "s" })],
      lastViewedAtOf: () => null,
    });
    expect(section(sections, "attention")).toBeUndefined();
  });

  it("caps attention and keeps overflow in recent, unduplicated", () => {
    const blocked = Array.from({ length: ATTENTION_MAX + 2 }, (_, i) =>
      task(`b${i}`, { awaiting_input: true, active_session_id: "s" }),
    );
    const sections = build({ sessions: [...blocked, task("plain")] });
    expect(sessionIds(sections, "attention")).toHaveLength(ATTENTION_MAX);
    // Overflowing attention sessions fall back to recent, still flagged.
    const recent = section(sections, "recent")?.items ?? [];
    expect(sessionIds(sections, "recent")).toEqual([
      `b${ATTENTION_MAX}`,
      `b${ATTENTION_MAX + 1}`,
      "plain",
    ]);
    expect(recent[0]).toMatchObject({ kind: "session", flag: "needs_input" });
  });

  it("caps recent and preserves the input (recency) order", () => {
    const sessions = Array.from({ length: RECENT_MAX + 3 }, (_, i) =>
      task(`s${i}`),
    );
    const sections = build({ sessions });
    expect(sessionIds(sections, "recent")).toEqual(
      sessions.slice(0, RECENT_MAX).map((t) => t.id),
    );
  });

  it("omits projects while browsing", () => {
    const sections = build({ projects: [{ id: "p1", name: "chro" }] });
    expect(section(sections, "projects")).toBeUndefined();
  });
});

describe("buildPaletteSections — searching", () => {
  it("returns commands, projects, then sessions, omitting empty sections", () => {
    const sections = build({
      query: "chro",
      commands: [{ id: "new-chat", label: "New chat" }],
      projects: [{ id: "p1", name: "chro" }],
      sessions: [task("a", { title: "chro palette" })],
    });
    expect(sections.map((s) => s.id)).toEqual(["projects", "sessions"]);
  });

  it("matches commands by label, case-insensitively", () => {
    const sections = build({ query: "NEW" });
    expect(section(sections, "commands")?.items).toEqual([
      { kind: "command", commandId: "new-chat" },
    ]);
  });

  it("ranks title prefix over title substring over project-name match", () => {
    const sections = build({
      query: "pal",
      sessions: [
        task("by-project", { title: "Unrelated", project_id: "pp" }),
        task("substr", { title: "command palette" }),
        task("prefix", { title: "palette rework" }),
      ],
      projectNameOf: (id) => (id === "pp" ? "palette-lab" : null),
    });
    expect(sessionIds(sections, "sessions")).toEqual([
      "prefix",
      "substr",
      "by-project",
    ]);
  });

  it("breaks score ties by input (recency) order", () => {
    const sections = build({
      query: "fix",
      sessions: [
        task("newer", { title: "fix palette" }),
        task("older", { title: "fix dock" }),
      ],
    });
    expect(sessionIds(sections, "sessions")).toEqual(["newer", "older"]);
  });

  it("drops sessions that match neither title nor project name", () => {
    const sections = build({
      query: "zzz",
      sessions: [task("a", { title: "nothing here" })],
    });
    expect(section(sections, "sessions")).toBeUndefined();
  });

  it("caps session results", () => {
    const sessions = Array.from({ length: SESSION_RESULTS_MAX + 5 }, (_, i) =>
      task(`s${i}`, { title: `match ${i}` }),
    );
    const sections = build({ query: "match", sessions });
    expect(sessionIds(sections, "sessions")).toHaveLength(SESSION_RESULTS_MAX);
  });

  it("ranks project name prefix over substring", () => {
    const sections = build({
      query: "app",
      projects: [
        { id: "sub", name: "the-app" },
        { id: "pre", name: "appliance" },
        { id: "none", name: "unrelated" },
      ],
    });
    const ids = (section(sections, "projects")?.items ?? []).flatMap((item) =>
      item.kind === "project" ? [item.projectId] : [],
    );
    expect(ids).toEqual(["pre", "sub"]);
  });

  it("caps project results", () => {
    const projects = Array.from(
      { length: PROJECT_RESULTS_MAX + 2 },
      (_, i) => ({
        id: `x${i}`,
        name: `app-${i}`,
      }),
    );
    const sections = build({ query: "app", projects });
    expect(section(sections, "projects")?.items).toHaveLength(
      PROJECT_RESULTS_MAX,
    );
  });

  it("still flags attention-worthy sessions in search results", () => {
    const sections = build({
      query: "match",
      sessions: [
        task("blocked", {
          title: "match blocked",
          awaiting_input: true,
          active_session_id: "s",
        }),
      ],
    });
    expect(section(sections, "sessions")?.items[0]).toMatchObject({
      kind: "session",
      flag: "needs_input",
    });
  });
});
