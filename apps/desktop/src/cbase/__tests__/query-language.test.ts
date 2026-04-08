import { describe, expect, it } from "vitest";
import { executeView } from "../engine";
import { parseCbase } from "../parser";
import type { CbaseRow } from "../types";

const row = (
  filePath: string,
  values: Record<string, unknown>,
  modifiedAt?: string,
): CbaseRow => ({
  filePath,
  displayName: filePath.split("/").pop()?.replace(/\.md$/i, "") ?? filePath,
  ...(modifiedAt ? { modifiedAt } : {}),
  values,
});

describe("Query language compatibility", () => {
  it("parses TABLE query and executes FROM/WHERE/SORT/LIMIT", () => {
    const query = `
TABLE title, status
FROM "tasks"
WHERE status != "done" AND priority >= 2
SORT priority DESC
LIMIT 10
`;

    const definition = parseCbase(query);
    const view = definition.views[0]!;

    const rows = [
      row("tasks/a.md", { title: "A", status: "todo", priority: 3 }),
      row("tasks/b.md", { title: "B", status: "done", priority: 5 }),
      row("notes/c.md", { title: "C", status: "todo", priority: 9 }),
    ];

    const result = executeView(
      rows,
      view,
      definition.properties,
      definition.filters,
      definition.sort,
    );

    expect(result.rows.map((entry) => entry.filePath)).toEqual(["tasks/a.md"]);
    expect(view.limit).toBe(10);
  });

  it("supports tag sources and file.mtime sorting", () => {
    const query = `
TABLE title
FROM #work OR #urgent
WHERE contains(title, "Roadmap")
SORT file.mtime DESC
`;

    const definition = parseCbase(query);
    const view = definition.views[0]!;

    const rows = [
      row(
        "notes/one.md",
        { title: "Roadmap alpha", tags: ["work"] },
        "2026-03-10T10:00:00.000Z",
      ),
      row(
        "notes/two.md",
        { title: "Roadmap beta", tags: ["urgent"] },
        "2026-03-11T10:00:00.000Z",
      ),
      row(
        "notes/three.md",
        { title: "Roadmap gamma", tags: ["personal"] },
        "2026-03-12T10:00:00.000Z",
      ),
    ];

    const result = executeView(
      rows,
      view,
      definition.properties,
      definition.filters,
      definition.sort,
    );

    expect(result.rows.map((entry) => entry.filePath)).toEqual([
      "notes/two.md",
      "notes/one.md",
    ]);
  });

  it("parses YAML query mode", () => {
    const yaml = `
version: 1
name: "Query Cbase"
query: |
  TABLE title
  FROM "notes"
  WHERE done = false
`;

    const definition = parseCbase(yaml);
    expect(definition.name).toBe("Query Cbase");
    expect(definition.dataset.include).toEqual(["**/*.md"]);
    expect(definition.views[0]?.default).toBe(true);
  });

  it("rejects unsupported GROUP BY", () => {
    const query = `
TABLE title
GROUP BY status
`;

    expect(() => parseCbase(query)).toThrow(/GROUP BY/);
  });

  it("parses fenced query block", () => {
    const query = `
\`\`\`query
TABLE title
WHERE title
\`\`\`
`;

    const definition = parseCbase(query);
    expect(definition.views).toHaveLength(1);
  });

  it("scopes dataset to base folder when FROM is omitted", () => {
    const query = `
TABLE title, status
WHERE status != "done"
`;

    const definition = parseCbase(query, {
      basePath: "tasks/overview/my-table.cbase",
    });

    expect(definition.dataset.include).toEqual(["tasks/overview/**/*.md"]);
  });

  it("keeps vault-wide dataset when FROM is present", () => {
    const query = `
TABLE title
FROM "tasks"
`;

    const definition = parseCbase(query, {
      basePath: "tasks/overview/my-table.cbase",
    });

    expect(definition.dataset.include).toEqual(["**/*.md"]);
  });
});
