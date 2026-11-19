import { describe, expect, it } from "vitest";
import { promptWithImage } from "./edge-send";

describe("promptWithImage", () => {
  it("puts the image before the text, as the composer does", () => {
    const image = {
      id: "i1",
      file_path: ".chro-images/a.png",
      original_name: "capture.png",
    };
    expect(promptWithImage("  why is this red? ", image)).toBe(
      "![capture.png](.chro-images/a.png)\nwhy is this red?",
    );
  });

  it("is the text alone without an image", () => {
    expect(promptWithImage("make it faster", null)).toBe("make it faster");
  });
});
