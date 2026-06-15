import { describe, expect, it } from "vitest";
import { resolveSessionTarget } from "../notification-target";

const task = (
  over: Partial<{ id: string; slug: string | null; project_id: string }> = {},
) => ({
  id: over.id ?? "task-uuid",
  slug: over.slug === undefined ? "task-slug" : over.slug,
  project_id: over.project_id ?? "proj-uuid",
});

describe("resolveSessionTarget", () => {
  it("prefers project and task slugs for clean URLs", () => {
    const target = resolveSessionTarget(task(), {
      "proj-uuid": { slug: "proj-slug" },
    });
    expect(target).toEqual({ projectId: "proj-slug", taskId: "task-slug" });
  });

  it("falls back to raw ids when slugs are missing", () => {
    const target = resolveSessionTarget(task({ slug: null }), {
      "proj-uuid": { slug: null },
    });
    expect(target).toEqual({ projectId: "proj-uuid", taskId: "task-uuid" });
  });

  it("falls back to the raw project id when the project is unknown", () => {
    const target = resolveSessionTarget(task(), {});
    expect(target).toEqual({ projectId: "proj-uuid", taskId: "task-slug" });
  });
});
