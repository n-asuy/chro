import { describe, expect, it } from "vitest";
import { resolveWebUrl } from "../web-address";

describe("resolveWebUrl", () => {
  it("resolves a scheme-less address to https", () => {
    expect(resolveWebUrl("chro-ai.com")).toBe("https://chro-ai.com");
    expect(resolveWebUrl("chro-ai.com/dl")).toBe("https://chro-ai.com/dl");
    expect(resolveWebUrl("docs.anthropic.com/en/docs")).toBe(
      "https://docs.anthropic.com/en/docs",
    );
  });

  it("keeps an explicit http(s) address as written", () => {
    expect(resolveWebUrl("https://chro-ai.com/dl?v=1")).toBe(
      "https://chro-ai.com/dl?v=1",
    );
    expect(resolveWebUrl("http://localhost:4310/rpc")).toBe(
      "http://localhost:4310/rpc",
    );
  });

  it("leaves file names that end in a TLD-shaped extension alone", () => {
    // Every one of these also parses as `<name>.<tld>`; the curated TLD set is
    // what keeps them out of the browser.
    for (const name of [
      "README.md",
      "main.rs",
      "build.sh",
      "libchro.so",
      "setup.py",
      "archive.zip",
      "clip.mov",
    ]) {
      expect(resolveWebUrl(name)).toBeNull();
    }
  });

  it("leaves paths, other schemes and non-addresses alone", () => {
    for (const value of [
      "src/session/components/markdown.tsx",
      "/Users/alice/Desktop/today",
      "./relative/file.txt",
      "~/notes.txt",
      "C:/Users/alice",
      "mailto:agent@skunc-ai.com",
      "file:///tmp/x",
      "chro-ai.com:8080",
      "package.json",
      "Node.js",
      "localhost",
      "#heading",
      "",
      "chro ai.com",
    ]) {
      expect(resolveWebUrl(value)).toBeNull();
    }
  });
});
