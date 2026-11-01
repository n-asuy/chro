import { describe, expect, it, vi } from "vitest";
import {
  attachedImagePath,
  localImageSource,
  remoteImageSource,
} from "../markdown-image-source";
import type { PathLinkTarget } from "../path-link";

vi.mock("@/lib/backend-client", () => ({
  getBackendBaseUrl: () => "http://127.0.0.1:4310/",
}));

const file = (absolutePath: string): PathLinkTarget => ({
  kind: "file",
  absolutePath,
  root: null,
  line: null,
  column: null,
});

describe("remoteImageSource", () => {
  it("loads web and inline images as written", () => {
    expect(remoteImageSource("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(remoteImageSource("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("leaves local paths to the server", () => {
    expect(remoteImageSource("/tmp/shots/before.png")).toBeNull();
    expect(remoteImageSource("docs/figure.svg")).toBeNull();
    expect(remoteImageSource("javascript:alert(1)")).toBeNull();
  });
});

describe("localImageSource", () => {
  it("serves a resolved file through the workspace binary endpoint", () => {
    const url = new URL(localImageSource(file("/tmp/shots/before.png")) ?? "");

    expect(url.origin + url.pathname).toBe(
      "http://127.0.0.1:4310/rpc/filesystem/workspace-binary-file",
    );
    expect(url.searchParams.get("abs_path")).toBe("/tmp/shots");
    expect(url.searchParams.get("relative_path")).toBe("before.png");
  });

  it("splits Windows paths on backslashes", () => {
    const url = new URL(
      localImageSource(file("C:\\Users\\alice\\shot.png")) ?? "",
    );

    expect(url.searchParams.get("abs_path")).toBe("C:\\Users\\alice");
    expect(url.searchParams.get("relative_path")).toBe("shot.png");
  });

  it("has nothing to show for an unresolved path or a directory", () => {
    expect(localImageSource(null)).toBeNull();
    expect(
      localImageSource({ ...file("/tmp/shots"), kind: "directory" }),
    ).toBeNull();
  });
});

// The prompt handed to the agent CLI carries attachments as absolute worktree
// paths, and the CLI echoes that back as the user message, so both spellings
// must resolve to the same attachment.
describe("attachedImagePath", () => {
  it("keeps the canonical relative attachment path", () => {
    expect(attachedImagePath(".chro-context/abc.png")).toBe(
      ".chro-context/abc.png",
    );
  });

  it("recovers the attachment from an absolute worktree path", () => {
    expect(
      attachedImagePath("/var/folders/T/worktrees/ch/f8dd-task/.chro-context/abc.png"),
    ).toBe(".chro-context/abc.png");
    expect(attachedImagePath("C:/wt/task/.chro-context/abc.png")).toBe(
      ".chro-context/abc.png",
    );
  });

  it("rejects anything that is not a file directly in the attachment dir", () => {
    expect(attachedImagePath("/tmp/shots/before.png")).toBeNull();
    expect(attachedImagePath("/wt/.chro-context/nested/abc.png")).toBeNull();
    expect(attachedImagePath("/wt/my.chro-context/abc.png")).toBeNull();
    expect(attachedImagePath("https://example.com/.chro-context/abc.png")).toBeNull();
  });
});
