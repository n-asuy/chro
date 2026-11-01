import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import { observeArchiveTransitions } from "./use-session-tab-archive-sync";

const task = (id: string, status: string, slug?: string): StoredTask => ({
  id,
  slug: slug ?? null,
  project_id: "p",
  title: id,
  status,
  created_at: "2026-10-31T00:00:00Z",
  updated_at: "2026-10-31T00:00:00Z",
  sort_order: 0,
});

const isArchived = (t: StoredTask) => t.status === "cancelled";

describe("observeArchiveTransitions", () => {
  it("reports a task that becomes archived, by id and slug", () => {
    const first = observeArchiveTransitions(
      new Map(),
      [task("a", "completed", "a-slug")],
      isArchived,
    );
    const second = observeArchiveTransitions(
      first.observed,
      [task("a", "cancelled", "a-slug")],
      isArchived,
    );
    expect([...second.newlyArchivedKeys].sort()).toEqual(["a", "a-slug"]);
  });

  it("does not report a task that was already archived when first seen", () => {
    // Opening an archived session from history must not close its tab.
    const first = observeArchiveTransitions(
      new Map(),
      [task("a", "cancelled")],
      isArchived,
    );
    expect(first.newlyArchivedKeys.size).toBe(0);
    const second = observeArchiveTransitions(
      first.observed,
      [task("a", "cancelled")],
      isArchived,
    );
    expect(second.newlyArchivedKeys.size).toBe(0);
  });

  it("forgets tasks that left the stream", () => {
    const first = observeArchiveTransitions(
      new Map(),
      [task("a", "completed")],
      isArchived,
    );
    const gone = observeArchiveTransitions(first.observed, [], isArchived);
    expect(gone.observed.size).toBe(0);
    const back = observeArchiveTransitions(
      gone.observed,
      [task("a", "cancelled")],
      isArchived,
    );
    expect(back.newlyArchivedKeys.size).toBe(0);
  });
});
