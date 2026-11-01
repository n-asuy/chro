import { describe, expect, it } from "vitest";
import {
  type BinaryFileData,
  type SceneElement,
  imagesToExternalize,
  parseScene,
  sceneSignature,
  serializeScene,
} from "./excalidraw-scene";

const element = (
  id: string,
  version: number,
  overrides: Partial<SceneElement> = {},
): SceneElement => ({
  id,
  type: "rectangle",
  version,
  isDeleted: false,
  ...overrides,
});

const image = (id: string): BinaryFileData => ({
  id,
  mimeType: "image/png",
  dataURL: `data:image/png;base64,${id}`,
  created: 1,
});

const appState = { viewBackgroundColor: "#ffffff", gridSize: null };

describe("parseScene", () => {
  it("returns an empty scene for blank content", () => {
    const scene = parseScene("  ");
    expect(scene.elements).toEqual([]);
    expect(scene.files).toEqual({});
    expect(scene.fileRefs).toEqual({});
  });

  it("returns an empty scene for content that is not a drawing", () => {
    expect(parseScene('{"type":"other"}').elements).toEqual([]);
    expect(parseScene("not json").elements).toEqual([]);
  });

  it("keeps the authoring tool recorded in the file", () => {
    const content = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [element("a", 1)],
    });
    const scene = parseScene(content);
    expect(scene.source).toBe("https://excalidraw.com");
    expect(scene.elements).toHaveLength(1);
  });
});

describe("sceneSignature", () => {
  const files = { img: image("img") };

  it("is stable when nothing persisted changed", () => {
    const elements = [element("a", 3)];
    expect(sceneSignature(elements, appState, files)).toBe(
      sceneSignature([element("a", 3)], { ...appState }, { ...files }),
    );
  });

  // Excalidraw reports scroll, zoom, selection and hover through the same
  // change callback; none of them is part of the saved document.
  it("ignores view-only state such as scroll and zoom", () => {
    const elements = [element("a", 3)];
    const scrolled = { ...appState, scrollX: 400, zoom: { value: 2 } };
    expect(sceneSignature(elements, scrolled, files)).toBe(
      sceneSignature(elements, appState, files),
    );
  });

  it("changes when an element is edited", () => {
    expect(sceneSignature([element("a", 4)], appState, files)).not.toBe(
      sceneSignature([element("a", 3)], appState, files),
    );
  });

  it("changes when an element is added or removed", () => {
    expect(
      sceneSignature([element("a", 3), element("b", 1)], appState, files),
    ).not.toBe(sceneSignature([element("a", 3)], appState, files));
  });

  it("changes when a persisted canvas setting changes", () => {
    const elements = [element("a", 3)];
    expect(
      sceneSignature(
        elements,
        { ...appState, viewBackgroundColor: "#000000" },
        files,
      ),
    ).not.toBe(sceneSignature(elements, appState, files));
    expect(
      sceneSignature(elements, { ...appState, gridSize: 20 }, files),
    ).not.toBe(sceneSignature(elements, appState, files));
  });

  it("changes when an image is added", () => {
    const elements = [element("a", 3)];
    expect(
      sceneSignature(elements, appState, { ...files, next: image("next") }),
    ).not.toBe(sceneSignature(elements, appState, files));
  });
});

describe("serializeScene", () => {
  it("drops deleted elements", () => {
    const content = serializeScene({
      source: "chro",
      elements: [element("a", 1), element("b", 2, { isDeleted: true })],
      appState,
      files: {},
      fileRefs: {},
    });
    expect(parseScene(content).elements.map((el) => el.id)).toEqual(["a"]);
  });

  it("stores externalized images by reference only", () => {
    const content = serializeScene({
      source: "chro",
      elements: [],
      appState,
      files: { stored: image("stored"), inline: image("inline") },
      fileRefs: {
        stored: { path: "a.excalidraw.images/x.png", mimeType: "image/png" },
      },
    });
    const scene = parseScene(content);
    expect(Object.keys(scene.files)).toEqual(["inline"]);
    expect(scene.fileRefs.stored?.path).toBe("a.excalidraw.images/x.png");
  });

  it("keeps the authoring tool it was given", () => {
    const content = serializeScene({
      source: "https://excalidraw.com",
      elements: [],
      appState,
      files: {},
      fileRefs: {},
    });
    expect(parseScene(content).source).toBe("https://excalidraw.com");
  });

  it("persists only the canvas settings, not the view", () => {
    const scrolled = { ...appState, scrollX: 400 };
    const content = serializeScene({
      source: "chro",
      elements: [],
      appState: scrolled,
      files: {},
      fileRefs: {},
    });
    expect(JSON.parse(content).appState).toEqual(appState);
  });
});

describe("imagesToExternalize", () => {
  it("selects images added during this session", () => {
    expect(
      imagesToExternalize({
        files: { fresh: image("fresh") },
        fileRefs: {},
        embeddedAtLoad: new Set(),
        inFlight: new Set(),
      }),
    ).toEqual(["fresh"]);
  });

  // Rewriting a drawing someone else authored into a different storage format
  // is not ours to do; images that arrived embedded stay embedded.
  it("leaves images that were embedded when the file was opened", () => {
    expect(
      imagesToExternalize({
        files: { original: image("original") },
        fileRefs: {},
        embeddedAtLoad: new Set(["original"]),
        inFlight: new Set(),
      }),
    ).toEqual([]);
  });

  it("skips images already stored by reference", () => {
    expect(
      imagesToExternalize({
        files: { stored: image("stored") },
        fileRefs: { stored: { path: "x.png", mimeType: "image/png" } },
        embeddedAtLoad: new Set(),
        inFlight: new Set(),
      }),
    ).toEqual([]);
  });

  // Excalidraw keeps calling back while an upload is pending; starting a
  // second upload of the same image wrote hundreds of duplicate files.
  it("skips images whose upload is already in progress", () => {
    expect(
      imagesToExternalize({
        files: { pending: image("pending") },
        fileRefs: {},
        embeddedAtLoad: new Set(),
        inFlight: new Set(["pending"]),
      }),
    ).toEqual([]);
  });
});
