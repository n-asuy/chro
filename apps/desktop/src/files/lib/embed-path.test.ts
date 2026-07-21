import { describe, expect, it } from "vitest";

import { resolveEmbedPath } from "./embed-path";

/**
 * `resolveEmbedPath` decides the path an image/embed reference inside a
 * document resolves to. The rule under test: absolute-ness is inherited from
 * the document, never guessed per reference.
 */
describe("resolveEmbedPath", () => {
  describe("workspace-relative document", () => {
    const doc = "docs/note.md";

    it("joins a relative reference against the document directory", () => {
      expect(resolveEmbedPath(doc, "img.png")).toBe("docs/img.png");
    });

    it("keeps the root-relative markdown meaning of a leading slash", () => {
      expect(resolveEmbedPath(doc, "/assets/img.png")).toBe("assets/img.png");
    });

    it("normalizes parent and current segments", () => {
      expect(resolveEmbedPath(doc, "../media/./img.png")).toBe("media/img.png");
    });

    it("treats a document at the root as having no directory", () => {
      expect(resolveEmbedPath("note.md", "img.png")).toBe("img.png");
    });
  });

  describe("host-absolute document", () => {
    const doc = "/Users/alice/vault/docs/note.md";

    it("resolves a relative reference in the document's absolute space", () => {
      expect(resolveEmbedPath(doc, "img.png")).toBe(
        "/Users/alice/vault/docs/img.png",
      );
    });

    it("keeps an absolute reference absolute", () => {
      expect(resolveEmbedPath(doc, "/Users/alice/shots/x.png")).toBe(
        "/Users/alice/shots/x.png",
      );
    });

    it("normalizes parent segments without escaping the leading slash", () => {
      expect(resolveEmbedPath(doc, "../media/img.png")).toBe(
        "/Users/alice/vault/media/img.png",
      );
    });

    it("does not let parent segments climb above the filesystem root", () => {
      expect(resolveEmbedPath("/a/note.md", "../../../img.png")).toBe(
        "/img.png",
      );
    });
  });

  describe("missing document path", () => {
    it("returns a relative reference unchanged", () => {
      expect(resolveEmbedPath(null, "img.png")).toBe("img.png");
    });

    it("strips a leading slash when there is no absolute context", () => {
      expect(resolveEmbedPath(null, "/img.png")).toBe("img.png");
    });
  });
});
