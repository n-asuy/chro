import type { FileSearchResult } from "@/files/lib/file-search";
import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import {
  type SearchIdRef,
  filterSessions,
  isCurrentRequest,
  mergeResults,
  nextSearchId,
} from "../global-search-logic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTask = (overrides: Partial<StoredTask> = {}): StoredTask => ({
  id: "task-1",
  project_id: "proj-1",
  title: "Fix login bug",
  status: "in_progress",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-02T00:00:00Z",
  ...overrides,
});

const makeFileResult = (
  overrides: Partial<FileSearchResult> = {},
): FileSearchResult => ({
  path: "src/main.ts",
  is_file: true,
  match_type: "FileName",
  name: "main.ts",
  normalizedPath: "/src/main.ts",
  ...overrides,
});

// ---------------------------------------------------------------------------
// filterSessions
// ---------------------------------------------------------------------------

describe("filterSessions", () => {
  const tasks: StoredTask[] = [
    makeTask({ id: "1", title: "Fix login bug" }),
    makeTask({ id: "2", title: "Add dark mode" }),
    makeTask({ id: "3", title: "Refactor login flow" }),
    makeTask({ id: "4", title: "Update docs" }),
  ];

  it("returns empty array for empty query", () => {
    expect(filterSessions(tasks, "")).toEqual([]);
    expect(filterSessions(tasks, "   ")).toEqual([]);
  });

  it("returns empty array for empty tasks", () => {
    expect(filterSessions([], "login")).toEqual([]);
  });

  it("filters tasks by title substring (case-insensitive)", () => {
    const results = filterSessions(tasks, "login");
    expect(results).toHaveLength(2);
    expect(results[0].task.id).toBe("1");
    expect(results[1].task.id).toBe("3");
  });

  it("matches case-insensitively", () => {
    const results = filterSessions(tasks, "LOGIN");
    expect(results).toHaveLength(2);
  });

  it("trims the query before searching", () => {
    const results = filterSessions(tasks, "  dark  ");
    expect(results).toHaveLength(1);
    expect(results[0].task.id).toBe("2");
  });

  it("caps results at 10", () => {
    const manyTasks = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `task-${i}`, title: `matching item ${i}` }),
    );
    const results = filterSessions(manyTasks, "matching");
    expect(results).toHaveLength(10);
  });

  it("sets category to 'session' on all results", () => {
    const results = filterSessions(tasks, "Fix");
    for (const r of results) {
      expect(r.category).toBe("session");
    }
  });

  it("skips tasks with empty title", () => {
    const tasksWithEmpty = [
      makeTask({ id: "1", title: "" }),
      makeTask({ id: "2", title: "Has title" }),
    ];
    const results = filterSessions(tasksWithEmpty, "title");
    expect(results).toHaveLength(1);
    expect(results[0].task.id).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// mergeResults
// ---------------------------------------------------------------------------

describe("mergeResults", () => {
  it("returns empty array when both inputs are empty", () => {
    expect(mergeResults([], [])).toEqual([]);
  });

  it("returns sessions only when no files", () => {
    const sessions = [
      { category: "session" as const, task: makeTask({ id: "s1" }) },
    ];
    const result = mergeResults(sessions, []);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("session");
  });

  it("returns files only when no sessions", () => {
    const files = [makeFileResult({ path: "a.ts" })];
    const result = mergeResults([], files);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("file");
  });

  it("puts sessions before files", () => {
    const sessions = [
      { category: "session" as const, task: makeTask({ id: "s1" }) },
    ];
    const files = [makeFileResult({ path: "a.ts" })];
    const result = mergeResults(sessions, files);
    expect(result).toHaveLength(2);
    expect(result[0].category).toBe("session");
    expect(result[1].category).toBe("file");
  });

  it("preserves order within each group", () => {
    const sessions = [
      { category: "session" as const, task: makeTask({ id: "s1" }) },
      { category: "session" as const, task: makeTask({ id: "s2" }) },
    ];
    const files = [
      makeFileResult({ path: "a.ts" }),
      makeFileResult({ path: "b.ts" }),
    ];
    const result = mergeResults(sessions, files);
    expect(result).toHaveLength(4);
    expect((result[0] as { task: StoredTask }).task.id).toBe("s1");
    expect((result[1] as { task: StoredTask }).task.id).toBe("s2");
    expect((result[2] as { file: FileSearchResult }).file.path).toBe("a.ts");
    expect((result[3] as { file: FileSearchResult }).file.path).toBe("b.ts");
  });
});

// ---------------------------------------------------------------------------
// nextSearchId / isCurrentRequest (race condition guard)
// ---------------------------------------------------------------------------

describe("nextSearchId", () => {
  it("increments the ref value", () => {
    const ref: SearchIdRef = { current: 0 };
    expect(nextSearchId(ref)).toBe(1);
    expect(ref.current).toBe(1);
    expect(nextSearchId(ref)).toBe(2);
    expect(ref.current).toBe(2);
  });

  it("returns the new value", () => {
    const ref: SearchIdRef = { current: 5 };
    const id = nextSearchId(ref);
    expect(id).toBe(6);
  });
});

describe("isCurrentRequest", () => {
  it("returns true when requestId matches ref", () => {
    const ref: SearchIdRef = { current: 3 };
    expect(isCurrentRequest(ref, 3)).toBe(true);
  });

  it("returns false when requestId is stale", () => {
    const ref: SearchIdRef = { current: 5 };
    expect(isCurrentRequest(ref, 3)).toBe(false);
  });
});

describe("race condition scenario", () => {
  it("clearing query invalidates previous request", () => {
    const ref: SearchIdRef = { current: 0 };

    // User types "foo" -> start search
    const requestId = nextSearchId(ref); // ref.current = 1
    expect(requestId).toBe(1);

    // User clears query -> invalidate
    nextSearchId(ref); // ref.current = 2

    // Previous search completes, but should be rejected
    expect(isCurrentRequest(ref, requestId)).toBe(false);
  });

  it("new search supersedes previous search", () => {
    const ref: SearchIdRef = { current: 0 };

    // User types "fo" -> search 1
    const id1 = nextSearchId(ref);
    expect(id1).toBe(1);

    // User types "foo" -> search 2
    const id2 = nextSearchId(ref);
    expect(id2).toBe(2);

    // Search 1 completes -> should be rejected
    expect(isCurrentRequest(ref, id1)).toBe(false);
    // Search 2 completes -> should be accepted
    expect(isCurrentRequest(ref, id2)).toBe(true);
  });
});
