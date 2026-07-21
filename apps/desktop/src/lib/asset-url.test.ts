import { describe, expect, it } from "vitest";

import {
  getProjectAssetUrl,
  getTaskRunAssetUrl,
  getWorkspaceAssetUrl,
} from "./project-client";

/** Mirror of the base64url encoding the asset URLs use for a root segment. */
const encodeRoot = (input: string): string =>
  btoa(unescape(encodeURIComponent(input)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * Asset URLs put the file path into URL path segments so that relative
 * references inside served HTML resolve to siblings via the same endpoint.
 * A host-absolute path cannot survive that encoding (the leading slash is not
 * a segment), so it must be carried as an encoded root plus a relative
 * remainder instead of being silently flattened into a project-relative path.
 */
describe("asset URLs", () => {
  describe("workspace-relative paths keep their scoped endpoint", () => {
    it("builds a project asset URL", () => {
      expect(getProjectAssetUrl("proj-1", "docs/index.html")).toBe(
        "/rpc/projects/proj-1/asset/docs/index.html",
      );
    });

    it("builds a task-run asset URL", () => {
      expect(getTaskRunAssetUrl("run-1", "docs/index.html")).toBe(
        "/rpc/task-runs/run-1/asset/docs/index.html",
      );
    });

    it("builds a workspace asset URL under its encoded root", () => {
      expect(getWorkspaceAssetUrl("/Users/alice/proj", "docs/index.html")).toBe(
        `/rpc/filesystem/workspace-asset/${encodeRoot("/Users/alice/proj")}/docs/index.html`,
      );
    });
  });

  describe("host-absolute paths route through the encoded-root endpoint", () => {
    const absolute = "/Users/alice/site/index.html";
    const expected = `/rpc/filesystem/workspace-asset/${encodeRoot("/Users/alice/site")}/index.html`;

    it("redirects a project asset URL", () => {
      expect(getProjectAssetUrl("proj-1", absolute)).toBe(expected);
    });

    it("redirects a task-run asset URL", () => {
      expect(getTaskRunAssetUrl("run-1", absolute)).toBe(expected);
    });

    it("redirects a workspace asset URL away from a mismatched root", () => {
      expect(getWorkspaceAssetUrl("/Users/alice/proj", absolute)).toBe(
        expected,
      );
    });

    it("never flattens the path into the scoped endpoint", () => {
      expect(getProjectAssetUrl("proj-1", absolute)).not.toContain(
        "/rpc/projects/proj-1/asset/Users",
      );
    });

    it("percent-encodes non-ASCII segments", () => {
      const url = getProjectAssetUrl(
        "proj-1",
        "/Users/alice/資料/スライド/index.html",
      );
      expect(url).toBe(
        `/rpc/filesystem/workspace-asset/${encodeRoot("/Users/alice/資料/スライド")}/index.html`,
      );
    });

    it("keeps siblings resolvable under the same directory prefix", () => {
      const page = getProjectAssetUrl("proj-1", absolute);
      const sibling = getProjectAssetUrl(
        "proj-1",
        "/Users/alice/site/style.css",
      );
      const prefixOf = (url: string) => url.slice(0, url.lastIndexOf("/"));
      expect(prefixOf(sibling)).toBe(prefixOf(page));
    });
  });
});
