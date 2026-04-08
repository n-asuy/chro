import { describe, expect, it } from "vitest";
import { parseCbase } from "../parser";
import { serializeCbase } from "../serializer";
import type { CbaseDefinition } from "../types";

const MINIMAL_YAML = `
version: 1
name: Test
dataset:
  include:
    - "**/*.md"
properties:
  title:
    key: title
    type: text
views:
  - id: default
    name: Default
    type: table
    table:
      columns:
        - title
`.trim();

describe("serializeCbase", () => {
  it("roundtrips a minimal definition", () => {
    const original = parseCbase(MINIMAL_YAML);
    const serialized = serializeCbase(original);
    const reparsed = parseCbase(serialized);

    expect(reparsed.name).toBe(original.name);
    expect(reparsed.dataset).toEqual(original.dataset);
    expect(Object.keys(reparsed.properties)).toEqual(
      Object.keys(original.properties),
    );
    expect(reparsed.views.length).toBe(original.views.length);
    expect(reparsed.views[0].table?.columns).toEqual(
      original.views[0].table?.columns,
    );
  });

  it("preserves sort and filters", () => {
    const yaml = `
version: 1
name: With Sort
dataset:
  include:
    - "docs/**/*.md"
  exclude:
    - "docs/drafts/**"
properties:
  status:
    key: status
    type: select
    options:
      - open
      - closed
  priority:
    key: priority
    type: number
filters:
  - property: status
    op: "!="
    value: closed
sort:
  - by: priority
    dir: desc
views:
  - id: main
    name: Main
    type: table
    default: true
    table:
      columns:
        - status
        - priority
      column_widths:
        status: 200
`.trim();

    const original = parseCbase(yaml);
    const serialized = serializeCbase(original);
    const reparsed = parseCbase(serialized);

    expect(reparsed.dataset.exclude).toEqual(["docs/drafts/**"]);
    expect(reparsed.filters).toHaveLength(1);
    expect(reparsed.sort).toEqual([{ by: "priority", dir: "desc" }]);
    expect(reparsed.views[0].default).toBe(true);
    expect(reparsed.views[0].table?.column_widths?.status).toBe(200);
    expect(reparsed.properties.status.options).toEqual(["open", "closed"]);
  });

  it("handles column update for persistence", () => {
    const original = parseCbase(MINIMAL_YAML);
    const updated: CbaseDefinition = {
      ...original,
      properties: {
        ...original.properties,
        file_name: { key: "file.name", type: "text", label: "Name" },
      },
      views: original.views.map((v) => ({
        ...v,
        table: { ...v.table, columns: ["title", "file_name"] },
      })),
    };

    const serialized = serializeCbase(updated);
    const reparsed = parseCbase(serialized);

    expect(reparsed.views[0].table?.columns).toEqual(["title", "file_name"]);
    expect(reparsed.properties.file_name.key).toBe("file.name");
  });
});
