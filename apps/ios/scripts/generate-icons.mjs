#!/usr/bin/env node
// Generates the app's icon assets from lucide-static (the same lucide version the
// desktop ships) as template vector images: Assets.xcassets/Lucide/<name>.imageset.
// Only the icons the app uses are generated; add a name to ICONS and rerun.
//
//   node apps/ios/scripts/generate-icons.mjs
//
// A name with "@<width>" keeps the icon but changes its stroke width
// (asset "<name>-sw<width>"), for the few places the mock draws a heavier glyph.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LUCIDE_VERSION = "0.441.0";

const ICONS = [
  // left panel
  "arrow-down-up", "chevrons-down-up", "plus", "search", "square-pen", "chevron-right", "chevron-down",
  "terminal", "message-square", "settings", "archive", "pin", "pin-off", "rotate-ccw", "check", "x",
  "loader-circle", "pause", "triangle-alert", "circle", "circle-slash", "arrow-down", "arrow-up",
  // navigation, Home and New session
  "chevron-left@2.2", "chevron-up", "panel-right", "book-open", "images", "folder", "folder-open", "git-branch", "laptop",
  "arrow-up@3", "arrow-left", "image", "file-text", "cpu", "box", "brain", "house", "file",
  // pairing
  "scan-qr-code", "clipboard-paste", "monitor", "trash-2", "link",
  // right dock, files, diff, editor, gallery, skills, settings and system screens
  "folder-tree", "folder-tree@1.5", "search@1.5", "git-branch@1.5", "waypoints", "waypoints@1.5",
  "file-diff", "upload", "download", "refresh-cw", "refresh-ccw", "list", "list-tree", "minus", "file-plus", "file-x", "file-pen",
  "git-merge", "git-compare-arrows", "minimize-2", "maximize-2", "folder-plus", "folder-input", "folder-root", "copy-plus", "case-sensitive",
  "external-link", "arrow-right", "arrow-up-down", "circle-help", "pencil", "undo-2", "redo-2", "save", "ellipsis",
  "zoom-in", "zoom-out", "rotate-cw", "image-off", "file-image", "code", "layout-list", "pen-line", "database", "table-2",
  "filter", "sliders-horizontal", "type", "hash", "calendar", "toggle-left", "braces", "grip-vertical", "list-plus@2.5",
  "bold", "italic", "strikethrough", "highlighter", "link-2", "copy", "square-check-big", "square", "circle-check",
  "circle-x", "circle-alert", "circle-minus", "megaphone", "bug", "lightbulb", "play", "send", "send-horizontal",
  "audio-lines", "globe", "eye", "hourglass", "hammer", "check@3", "list-plus",
];

const here = dirname(fileURLToPath(import.meta.url));
const catalog = join(here, "..", "ChroMobile", "Resources", "Assets.xcassets");
const folder = join(catalog, "Lucide");

const work = mkdtempSync(join(tmpdir(), "lucide-static-"));
try {
  execFileSync("npm", ["pack", `lucide-static@${LUCIDE_VERSION}`, "--silent"], { cwd: work, stdio: ["ignore", "pipe", "inherit"] });
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  execFileSync("tar", ["-xzf", tarball], { cwd: work });
  const source = join(work, "package", "icons");

  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "Contents.json"), json({ info: { author: "xcode", version: 1 }, properties: { "provides-namespace": true } }));

  for (const spec of ICONS) {
    const [name, width] = spec.split("@");
    const file = join(source, `${name}.svg`);
    if (!existsSync(file)) throw new Error(`lucide-static ${LUCIDE_VERSION} has no icon "${name}"`);
    let svg = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->\s*/g, "").replace(/\sclass="[^"]*"/, "");
    // The asset compiler does not resolve currentColor; template rendering only uses the alpha.
    svg = svg.replaceAll('"currentColor"', '"#000000"');
    if (width) svg = svg.replace(/stroke-width="[^"]*"/, `stroke-width="${width}"`);
    const asset = width ? `${name}-sw${width.replace(".", "_")}` : name;
    const set = join(folder, `${asset}.imageset`);
    mkdirSync(set, { recursive: true });
    writeFileSync(join(set, `${asset}.svg`), svg);
    writeFileSync(join(set, "Contents.json"), json({
      images: [{ filename: `${asset}.svg`, idiom: "universal" }],
      info: { author: "xcode", version: 1 },
      properties: { "preserves-vector-representation": true, "template-rendering-intent": "template" },
    }));
  }
  console.log(`generated ${ICONS.length} lucide ${LUCIDE_VERSION} icons in ${folder}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
