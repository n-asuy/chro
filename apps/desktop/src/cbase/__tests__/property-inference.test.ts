import { describe, expect, it } from "vitest";
import { mergeInferredProperties } from "../property-inference";
import type { LensRow } from "../types";

const rows: LensRow[] = [
  {
    filePath: "notes/alpha.md",
    displayName: "alpha",
    modifiedAt: "2025-01-02T03:04:05.000Z",
    values: {
      title: "Alpha",
      priority: 2,
      done: false,
      tags: ["work", "writing"],
      due: "2025-01-10",
      website: "https://example.com/alpha",
    },
  },
  {
    filePath: "notes/beta.md",
    displayName: "beta",
    modifiedAt: "2025-01-03T03:04:05.000Z",
    values: {
      title: "Beta",
      priority: 5,
      done: true,
      tags: ["personal"],
      due: "2025-02-11",
      website: "https://example.com/beta",
    },
  },
];

describe("mergeInferredProperties", () => {
  it("adds built-in and frontmatter-backed properties when schema is sparse", () => {
    const merged = mergeInferredProperties({}, rows);

    const byKey = Object.fromEntries(
      Object.entries(merged).map(([propertyId, property]) => [property.key, { propertyId, property }]),
    );

    expect(byKey["file.name"]?.property.label).toBe("Name");
    expect(byKey["file.path"]?.property.label).toBe("Path");
    expect(byKey.title?.property.type).toBe("text");
    expect(byKey.priority?.property.type).toBe("number");
    expect(byKey.done?.property.type).toBe("checkbox");
    expect(byKey.tags?.property.type).toBe("multi_select");
    expect(byKey.due?.property.type).toBe("date");
    expect(byKey.website?.property.type).toBe("url");
  });

  it("keeps explicit properties as the source of truth", () => {
    const merged = mergeInferredProperties(
      {
        name: { key: "file.name", label: "Custom name", type: "text" },
        title: { key: "title", label: "Headline", type: "text" },
      },
      rows,
    );

    expect(merged.name).toEqual({
      key: "file.name",
      label: "Custom name",
      type: "text",
    });
    expect(merged.title).toEqual({
      key: "title",
      label: "Headline",
      type: "text",
    });
    expect(
      Object.values(merged).filter((property) => property.key === "file.name"),
    ).toHaveLength(1);
    expect(
      Object.values(merged).filter((property) => property.key === "title"),
    ).toHaveLength(1);
  });
});
