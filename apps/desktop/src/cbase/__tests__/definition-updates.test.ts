import { describe, expect, it } from "vitest";
import { updateViewFilters } from "../definition-updates";
import { parseLens } from "../parser";
import type { LensProperty } from "../types";

const BASE_YAML = `
version: 1
name: Tasks
dataset:
  include:
    - "**/*.md"
properties:
  file_path:
    key: file.path
    type: text
views:
  - id: all
    name: All
    type: table
    default: true
    table:
      columns:
        - file_path
  - id: done
    name: Done
    type: table
    filters:
      - property: file_path
        op: contains
        value: done
    table:
      columns:
        - file_path
`.trim();

describe("updateViewFilters", () => {
  it("updates only the active view filters", () => {
    const definition = parseLens(BASE_YAML);

    const updated = updateViewFilters(definition, "all", [
      { property: "file_path", op: "contains", value: "roadmap" },
    ]);

    expect(updated.views[0].filters).toEqual([
      { property: "file_path", op: "contains", value: "roadmap" },
    ]);
    expect(updated.views[1].filters).toEqual([
      { property: "file_path", op: "contains", value: "done" },
    ]);
  });

  it("removes view filters when cleared", () => {
    const definition = parseLens(BASE_YAML);

    const updated = updateViewFilters(definition, "done", []);

    expect(updated.views[1].filters).toBeUndefined();
  });

  it("adds inferred properties referenced by nested filters", () => {
    const definition = parseLens(BASE_YAML);
    const inferredProperties: Record<string, LensProperty> = {
      file_path: { key: "file.path", type: "text" },
      status: {
        key: "status",
        type: "select",
        options: ["open", "closed"],
      },
    };

    const updated = updateViewFilters(
      definition,
      "all",
      [
        {
          or: [
            { property: "file_path", op: "contains", value: "roadmap" },
            { property: "status", op: "=", value: "open" },
          ],
        },
      ],
      inferredProperties,
    );

    expect(updated.properties.status).toEqual(inferredProperties.status);
    expect(updated.views[0].filters).toEqual([
      {
        or: [
          { property: "file_path", op: "contains", value: "roadmap" },
          { property: "status", op: "=", value: "open" },
        ],
      },
    ]);
  });
});
