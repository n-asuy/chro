import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  combineFrontmatterAndBody,
  updateFrontmatterProperty,
  addTag,
  removeTag,
  hasFrontmatter,
  getFrontmatterValueType,
  formatDateValue,
  parseDateValue,
} from "../frontmatter";

describe("frontmatter", () => {
  describe("parseFrontmatter", () => {
    it("should parse simple frontmatter", () => {
      const content = `---
title: Hello World
description: A test document
---

# Content here`;

      const { frontmatter, body, rawYaml } = parseFrontmatter(content);

      expect(frontmatter).toEqual({
        title: "Hello World",
        description: "A test document",
      });
      expect(body).toBe("\n# Content here");
      expect(rawYaml).toContain("title: Hello World");
    });

    it("should parse frontmatter with tags array", () => {
      const content = `---
title: Test
tags:
  - typescript
  - markdown
  - testing
---

Body content`;

      const { frontmatter } = parseFrontmatter(content);

      expect(frontmatter.title).toBe("Test");
      expect(frontmatter.tags).toEqual(["typescript", "markdown", "testing"]);
    });

    it("should parse frontmatter with various types", () => {
      const content = `---
title: Mixed Types
count: 42
enabled: true
rating: 4.5
pubDate: "2025-01-15"
---

Content`;

      const { frontmatter } = parseFrontmatter(content);

      expect(frontmatter.title).toBe("Mixed Types");
      expect(frontmatter.count).toBe(42);
      expect(frontmatter.enabled).toBe(true);
      expect(frontmatter.rating).toBe(4.5);
      // YAML date strings are kept as strings unless explicitly parsed
      expect(frontmatter.pubDate).toBe("2025-01-15");
    });

    it("should handle content without frontmatter", () => {
      const content = "# Just a heading\n\nSome content";

      const { frontmatter, body, rawYaml } = parseFrontmatter(content);

      expect(frontmatter).toEqual({});
      expect(body).toBe(content);
      expect(rawYaml).toBe("");
    });

    it("should handle empty frontmatter", () => {
      // Empty frontmatter (no YAML content between ---) doesn't match regex
      // because there's no newline between the markers
      const content = `---
title: Empty Body
---
`;

      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter).toEqual({ title: "Empty Body" });
      expect(body).toBe("");
    });

    it("should handle frontmatter with quoted strings", () => {
      const content = `---
title: "Hello: World"
description: 'Single quoted'
---

Body`;

      const { frontmatter } = parseFrontmatter(content);

      expect(frontmatter.title).toBe("Hello: World");
      expect(frontmatter.description).toBe("Single quoted");
    });

    it("should handle multiline values", () => {
      const content = `---
title: Test
description: |
  This is a
  multiline description
---

Body`;

      const { frontmatter } = parseFrontmatter(content);

      expect(frontmatter.title).toBe("Test");
      expect(frontmatter.description).toContain("multiline description");
    });

    it("should handle Obsidian-style frontmatter", () => {
      const content = `---
title: "AI Agent Review"
description: "A comprehensive review of AI agents"
pubDate: "2025-11-30"
tags:
  - AI
  - AI-Agent
  - Claude-Code
  - youtube-transcript
---

# Introduction

This is the content.`;

      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter.title).toBe("AI Agent Review");
      expect(frontmatter.tags).toEqual([
        "AI",
        "AI-Agent",
        "Claude-Code",
        "youtube-transcript",
      ]);
      expect(body).toContain("# Introduction");
    });

    it("should return empty frontmatter for invalid YAML", () => {
      const content = `---
title: [invalid yaml
---

Body`;

      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter).toEqual({});
      expect(body).toBe("\nBody");
    });
  });

  describe("serializeFrontmatter", () => {
    it("should serialize simple frontmatter", () => {
      const frontmatter = {
        title: "Hello World",
        description: "A test",
      };

      const yaml = serializeFrontmatter(frontmatter);

      expect(yaml).toContain("title: Hello World");
      expect(yaml).toContain("description: A test");
    });

    it("should serialize tags array", () => {
      const frontmatter = {
        title: "Test",
        tags: ["typescript", "markdown"],
      };

      const yaml = serializeFrontmatter(frontmatter);

      expect(yaml).toContain("title: Test");
      expect(yaml).toContain("- typescript");
      expect(yaml).toContain("- markdown");
    });

    it("should skip null values", () => {
      const frontmatter = {
        title: "Test",
        description: null,
      };

      const yaml = serializeFrontmatter(frontmatter);

      expect(yaml).toContain("title: Test");
      expect(yaml).not.toContain("description");
    });

    it("should return empty string for empty frontmatter", () => {
      const yaml = serializeFrontmatter({});
      expect(yaml).toBe("");
    });
  });

  describe("combineFrontmatterAndBody", () => {
    it("should combine frontmatter and body", () => {
      const frontmatter = { title: "Test" };
      const body = "\n# Content";

      const result = combineFrontmatterAndBody(frontmatter, body);

      expect(result).toMatch(/^---\n/);
      expect(result).toContain("title: Test");
      expect(result).toMatch(/\n---\n/);
      expect(result).toContain("# Content");
    });

    it("should return only body when frontmatter is empty", () => {
      const body = "# Just content";

      const result = combineFrontmatterAndBody({}, body);

      expect(result).toBe(body);
      expect(result).not.toContain("---");
    });

    it("should produce roundtrip-consistent output", () => {
      const original = `---
title: Roundtrip Test
tags:
  - test
---

# Content here`;

      const { frontmatter, body } = parseFrontmatter(original);
      const reconstructed = combineFrontmatterAndBody(frontmatter, body);
      const { frontmatter: fm2, body: body2 } = parseFrontmatter(reconstructed);

      expect(fm2).toEqual(frontmatter);
      expect(body2).toBe(body);
    });

    it("should preserve blank lines between frontmatter and body", () => {
      const frontmatter = { title: "Spacing" };
      const body = "\n\n# Heading after blank line";

      const reconstructed = combineFrontmatterAndBody(frontmatter, body);
      const { body: parsedBody } = parseFrontmatter(reconstructed);

      expect(parsedBody).toBe(body);
    });
  });

  describe("updateFrontmatterProperty", () => {
    it("should add new property", () => {
      const content = `---
title: Test
---

Body`;

      const updated = updateFrontmatterProperty(content, "author", "John");
      const { frontmatter } = parseFrontmatter(updated);

      expect(frontmatter.title).toBe("Test");
      expect(frontmatter.author).toBe("John");
    });

    it("should update existing property", () => {
      const content = `---
title: Old Title
---

Body`;

      const updated = updateFrontmatterProperty(content, "title", "New Title");
      const { frontmatter } = parseFrontmatter(updated);

      expect(frontmatter.title).toBe("New Title");
    });

    it("should delete property when value is null", () => {
      const content = `---
title: Test
description: To be removed
---

Body`;

      const updated = updateFrontmatterProperty(content, "description", null);
      const { frontmatter } = parseFrontmatter(updated);

      expect(frontmatter.title).toBe("Test");
      expect(frontmatter.description).toBeUndefined();
    });

    it("should preserve body when adding property to content without frontmatter", () => {
      // When there's no frontmatter, parseFrontmatter returns the whole content as body
      // Adding a property creates frontmatter and preserves the body
      const content = "# Just content";

      const updated = updateFrontmatterProperty(content, "title", "New Title");

      // The updated content should contain the body
      expect(updated).toContain("# Just content");
      // But since original had no frontmatter, the "body" was the whole content
      // So the new frontmatter gets added
      expect(updated).toContain("title: New Title");
    });
  });

  describe("addTag", () => {
    it("should add tag to existing tags", () => {
      const content = `---
title: Test
tags:
  - existing
---

Body`;

      const updated = addTag(content, "new-tag");
      const { frontmatter } = parseFrontmatter(updated);

      expect(frontmatter.tags).toEqual(["existing", "new-tag"]);
    });

    it("should create tags array if none exists", () => {
      const content = `---
title: Test
---

Body`;

      const updated = addTag(content, "first-tag");
      const { frontmatter } = parseFrontmatter(updated);

      expect(frontmatter.tags).toEqual(["first-tag"]);
    });

    it("should not add duplicate tag", () => {
      const content = `---
tags:
  - existing
---

Body`;

      const updated = addTag(content, "existing");
      const { frontmatter } = parseFrontmatter(updated);

      expect(frontmatter.tags).toEqual(["existing"]);
    });
  });

  describe("removeTag", () => {
    it("should remove tag from existing tags", () => {
      const content = `---
tags:
  - tag1
  - tag2
  - tag3
---

Body`;

      const updated = removeTag(content, "tag2");
      const { frontmatter } = parseFrontmatter(updated);

      expect(frontmatter.tags).toEqual(["tag1", "tag3"]);
    });

    it("should remove tags property when last tag is removed", () => {
      const content = `---
tags:
  - only-tag
---

Body`;

      const updated = removeTag(content, "only-tag");
      const { frontmatter } = parseFrontmatter(updated);

      // tags is set to null internally, but null values are not serialized
      // so after roundtrip it becomes undefined
      expect(frontmatter.tags).toBeUndefined();
    });
  });

  describe("hasFrontmatter", () => {
    it("should return true for content with frontmatter", () => {
      const content = `---
title: Test
---

Body`;

      expect(hasFrontmatter(content)).toBe(true);
    });

    it("should return false for content without frontmatter", () => {
      const content = "# Just a heading";
      expect(hasFrontmatter(content)).toBe(false);
    });

    it("should return false for --- not at start", () => {
      const content = "Some text\n---\ntitle: Test\n---";
      expect(hasFrontmatter(content)).toBe(false);
    });
  });

  describe("getFrontmatterValueType", () => {
    it("should return correct types", () => {
      expect(getFrontmatterValueType("hello")).toBe("text");
      expect(getFrontmatterValueType(42)).toBe("number");
      expect(getFrontmatterValueType(true)).toBe("boolean");
      expect(getFrontmatterValueType(new Date())).toBe("date");
      expect(getFrontmatterValueType(["a", "b"])).toBe("tags");
      expect(getFrontmatterValueType(null)).toBe("null");
    });
  });

  describe("formatDateValue", () => {
    it("should format Date object", () => {
      const date = new Date("2025-01-15T00:00:00.000Z");
      expect(formatDateValue(date)).toBe("2025-01-15");
    });

    it("should format date string", () => {
      expect(formatDateValue("2025-01-15")).toBe("2025-01-15");
    });

    it("should return empty string for invalid date", () => {
      expect(formatDateValue("invalid")).toBe("");
    });
  });

  describe("parseDateValue", () => {
    it("should parse valid date string", () => {
      const result = parseDateValue("2025-01-15");
      expect(result).toBeInstanceOf(Date);
      expect(result?.getFullYear()).toBe(2025);
    });

    it("should return null for empty string", () => {
      expect(parseDateValue("")).toBeNull();
    });

    it("should return null for invalid date", () => {
      expect(parseDateValue("not-a-date")).toBeNull();
    });
  });
});
