import { describe, expect, it } from "vitest";
import {
  PREVIEW_LINK_MESSAGE_TYPE,
  type PreviewLinkMessage,
  parsePreviewLinkMessage,
  resolvePreviewLinkTarget,
} from "./preview-link";

const ORIGIN = "http://127.0.0.1:4310";
const ASSET_DIR = `${ORIGIN}/rpc/projects/p1/asset/docs`;

/** A click on a link inside a document served from `ASSET_DIR`. */
const click = (
  href: string,
  url = `${ASSET_DIR}/${href}`,
): PreviewLinkMessage => ({
  href,
  url,
  local: url.startsWith(ORIGIN),
});

describe("parsePreviewLinkMessage", () => {
  it("accepts a well-formed bridge report", () => {
    expect(
      parsePreviewLinkMessage({
        type: PREVIEW_LINK_MESSAGE_TYPE,
        href: "todo.md",
        url: `${ASSET_DIR}/todo.md`,
        local: true,
      }),
    ).toEqual({
      href: "todo.md",
      url: `${ASSET_DIR}/todo.md`,
      local: true,
    });
  });

  // The preview renders arbitrary project HTML, which may post its own
  // messages to the embedder. Only the exact shape may reach the file-open path.
  it("rejects foreign or malformed messages", () => {
    expect(parsePreviewLinkMessage(null)).toBeNull();
    expect(parsePreviewLinkMessage("chro:preview-link")).toBeNull();
    expect(parsePreviewLinkMessage({ type: "other", href: "a.md" })).toBeNull();
    expect(
      parsePreviewLinkMessage({
        type: PREVIEW_LINK_MESSAGE_TYPE,
        href: "a.md",
      }),
    ).toBeNull();
    expect(
      parsePreviewLinkMessage({
        type: PREVIEW_LINK_MESSAGE_TYPE,
        href: "a.md",
        url: `${ASSET_DIR}/a.md`,
        local: "yes",
      }),
    ).toBeNull();
  });
});

describe("resolvePreviewLinkTarget", () => {
  it("opens a sibling file relative to the previewed document", () => {
    expect(
      resolvePreviewLinkTarget(click("todo.md"), "docs/index.html"),
    ).toEqual({
      kind: "file",
      path: "docs/todo.md",
    });
  });

  it("walks out of the document's directory", () => {
    expect(
      resolvePreviewLinkTarget(
        click(
          "../notes/todo.md",
          `${ORIGIN}/rpc/projects/p1/asset/notes/todo.md`,
        ),
        "docs/index.html",
      ),
    ).toEqual({ kind: "file", path: "notes/todo.md" });
  });

  // A root-relative href in a workspace-relative document means "from the
  // workspace root", matching how the app resolves markdown references.
  it("treats a root-relative link as workspace-relative", () => {
    expect(
      resolvePreviewLinkTarget(
        click("/README.md", `${ORIGIN}/README.md`),
        "docs/index.html",
      ),
    ).toEqual({ kind: "file", path: "README.md" });
  });

  // A document opened by host-absolute path resolves its links in that same
  // space, otherwise the target would be looked up under the wrong root.
  it("keeps host-absolute documents in absolute space", () => {
    expect(
      resolvePreviewLinkTarget(
        click("todo.md"),
        "/Users/alice/site/index.html",
      ),
    ).toEqual({ kind: "file", path: "/Users/alice/site/todo.md" });
  });

  it("drops the query and fragment of a file link", () => {
    expect(
      resolvePreviewLinkTarget(click("todo.md?v=2#section"), "docs/index.html"),
    ).toEqual({ kind: "file", path: "docs/todo.md" });
  });

  it("decodes percent-encoded path segments", () => {
    expect(
      resolvePreviewLinkTarget(click("my%20note.md"), "docs/index.html"),
    ).toEqual({ kind: "file", path: "docs/my note.md" });
  });

  it("sends a remote page to the system browser", () => {
    expect(
      resolvePreviewLinkTarget(
        click("https://example.com/docs", "https://example.com/docs"),
        "docs/index.html",
      ),
    ).toEqual({ kind: "external", url: "https://example.com/docs" });
  });

  it("sends a mail link to the system handler", () => {
    expect(
      resolvePreviewLinkTarget(
        click("mailto:a@example.com", "mailto:a@example.com"),
        "docs/index.html",
      ),
    ).toEqual({ kind: "external", url: "mailto:a@example.com" });
  });

  // Handing a script URL to the OS opener would turn a previewed document into
  // an execution sink.
  it("ignores non-browser schemes", () => {
    expect(
      resolvePreviewLinkTarget(
        click("javascript:alert(1)", "javascript:alert(1)"),
        "docs/index.html",
      ),
    ).toBeNull();
    expect(
      resolvePreviewLinkTarget(
        click("file:///etc/passwd", "file:///etc/passwd"),
        "docs/index.html",
      ),
    ).toBeNull();
  });

  // Same origin but written as a full address: it names an asset route, and no
  // file path can be recovered from it without guessing at the route prefix.
  it("ignores a same-origin absolute address", () => {
    expect(
      resolvePreviewLinkTarget(
        click(`${ASSET_DIR}/todo.md`, `${ASSET_DIR}/todo.md`),
        "docs/index.html",
      ),
    ).toBeNull();
  });

  it("ignores an empty or fragment-only href", () => {
    expect(resolvePreviewLinkTarget(click("  "), "docs/index.html")).toBeNull();
    expect(
      resolvePreviewLinkTarget(click("#section"), "docs/index.html"),
    ).toBeNull();
  });
});
