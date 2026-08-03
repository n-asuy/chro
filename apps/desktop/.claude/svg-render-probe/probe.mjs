/**
 * Browser-level check for the WYSIWYG editor's raw-HTML rendering.
 *
 * The unit suite (html-plugin.test.ts) runs without a DOM, so it can cover
 * decoration placement but not what the sanitizer keeps or what the stylesheet
 * does to it. This runs the editor's real extension set (createWysiwygPlugin,
 * i.e. every competing prose plugin) against the real Tailwind-compiled
 * globals.css in Chromium and WebKit, asserts the painted SVG geometry and the
 * sanitizer policy, and writes a screenshot per engine.
 *
 * Run from apps/desktop:  node .claude/svg-render-probe/probe.mjs
 */
import { chromium, webkit } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const desktop = path.resolve(here, "../..");
const bin = (name) => path.resolve(desktop, "../../node_modules/.bin", name);
const bundlePath = path.join(here, "bundle.js");
const cssPath = path.join(here, "app.css");

execFileSync(
  bin("esbuild"),
  [
    path.join(here, "entry.ts"),
    "--bundle",
    "--format=iife",
    `--outfile=${bundlePath}`,
    "--loader:.woff2=dataurl",
    "--loader:.woff=dataurl",
    "--loader:.ttf=dataurl",
  ],
  { stdio: "inherit", cwd: desktop },
);

execFileSync(
  bin("tailwindcss"),
  [
    "-c",
    path.join(desktop, "tailwind.config.ts"),
    "-i",
    path.join(desktop, "src/app/globals.css"),
    "-o",
    cssPath,
  ],
  { stdio: "inherit", cwd: desktop },
);

const bundle = fs.readFileSync(bundlePath, "utf8");
const appCss = fs.readFileSync(cssPath, "utf8");
if (!appCss.includes("cm-html-block-container")) {
  throw new Error("compiled stylesheet is missing the HTML block rules");
}

const DIAGRAM = `<div class="dgm">
<p class="dt">図2. ターンが開いてから閉じるまでの時間軸</p>
<svg viewBox="0 0 1000 300" role="img" aria-label="発話開始と終了の判定タイムライン">
  <line x1="70" y1="120" x2="960" y2="120" stroke="#9aa0a6" stroke-width="1.5"/>
  <rect x="70" y="96" width="150" height="48" rx="5" fill="#e8f0fe" stroke="#1a73e8"/>
  <text class="t-md" x="145" y="125" text-anchor="middle">相手が話している</text>
  <line x1="220" y1="70" x2="220" y2="170" stroke="#202124" stroke-width="1.5"/>
  <text class="t-lbl" x="228" y="86">最後の音</text>
  <text class="t-sub" x="228" y="163">ここから沈黙を数え始める</text>
</svg>
</div>

下読み`;

// A note that carries its own palette, the way these diagrams are authored.
const SELF_STYLED = `<div class="dgm">
<style>.dgm { --ink: #202124; --b50: #e8f0fe; } .dgm .t-md { font-size: 20px; }</style>
<svg viewBox="0 0 100 40"><rect id="swatch" x="0" y="0" width="60" height="30" fill="var(--b50)"/><text class="t-md" x="0" y="38">label</text></svg>
</div>

trailing`;

const HOSTILE = `<div id="hostile">
<script>window.__executed = true;</script>
<img src="x" onerror="window.__executed = true">
<a href="javascript:window.__executed = true">link</a>
<a href="https://example.com" target="_blank">external</a>
<iframe src="https://example.com/embed" allowfullscreen></iframe>
<svg viewBox="0 0 10 10"><script>window.__executed = true;</script><circle cx="5" cy="5" r="4"/></svg>
</div>

trailing`;

// Mirrors codemirror-editor.tsx's wrapper element.
const BODY = `<div class="cm-editor-container"><div id="editor"></div></div>`;

const page = () => `<!doctype html><html data-theme="light"><head>
<style>${appCss}</style>
<style>body { margin: 0; padding: 24px; } .cm-editor-container { width: 900px; }</style>
</head><body>${BODY}
<script>${bundle}</script>
</body></html>`;

let failures = 0;
function report(engine, group, checks, observed) {
  console.log(`\n[${engine}] ${group}`, JSON.stringify(observed));
  for (const [label, ok] of checks) {
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  }
}

for (const [name, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await engine.launch();
  const tab = await browser.newPage({ viewport: { width: 1000, height: 700 } });

  // --- rendering ---
  await tab.setContent(page());
  await tab.evaluate((doc) => window.mountEditor(doc), DIAGRAM);
  await tab.waitForTimeout(200);

  const drawn = await tab.evaluate(() => {
    const svg = document.querySelector(".cm-html-block-container svg");
    if (!svg) return { error: "no <svg> rendered" };
    const style = (selector) => {
      const el = svg.querySelector(selector);
      return el ? getComputedStyle(el) : null;
    };
    const rect = style("rect");
    const line = style("line");
    const text = svg.querySelector("text");
    return {
      svgChildCount: svg.children.length,
      svgHeight: svg.getBoundingClientRect().height,
      rectFill: rect?.fill,
      rectWidth: rect?.width,
      lineStroke: line?.stroke,
      lineStrokeWidth: line?.strokeWidth,
      textPainted: text ? text.getBoundingClientRect().width > 0 : false,
      caption:
        document.querySelector(".cm-html-block-container p.dt")?.textContent ??
        null,
    };
  });

  report(
    name,
    "rendering",
    [
      ["svg keeps all 6 child elements", drawn.svgChildCount === 6],
      ["svg has real height", drawn.svgHeight > 100],
      ["rect keeps its fill", drawn.rectFill === "rgb(232, 240, 254)"],
      ["rect keeps its width", drawn.rectWidth === "150px"],
      ["line keeps its stroke", drawn.lineStroke === "rgb(154, 160, 166)"],
      ["line keeps its stroke-width", drawn.lineStrokeWidth === "1.5px"],
      ["text is painted", drawn.textPainted === true],
      ["sibling HTML still renders", drawn.caption?.includes("図2") === true],
    ],
    drawn,
  );

  await tab.screenshot({ path: path.join(here, `rendered-${name}.png`) });

  // --- note-supplied CSS ---
  await tab.setContent(page());
  await tab.evaluate((doc) => window.mountEditor(doc), SELF_STYLED);
  await tab.waitForTimeout(200);

  const styled = await tab.evaluate(() => {
    const swatch = document.getElementById("swatch");
    const label = document.querySelector(".cm-html-block-container text.t-md");
    return {
      swatchFill: swatch ? getComputedStyle(swatch).fill : null,
      labelFontSize: label ? getComputedStyle(label).fontSize : null,
    };
  });

  report(
    name,
    "note CSS",
    [
      [
        "custom property resolves in a presentation attribute",
        styled.swatchFill === "rgb(232, 240, 254)",
      ],
      ["note rule styles SVG text", styled.labelFontSize === "20px"],
    ],
    styled,
  );

  // --- sanitizer policy ---
  await tab.setContent(page());
  await tab.evaluate((doc) => window.mountEditor(doc), HOSTILE);
  await tab.waitForTimeout(200);

  const policy = await tab.evaluate(() => {
    const host = document.querySelector(".cm-html-block-container");
    const link = host?.querySelector('a[href^="https"]');
    return {
      executed: window.__executed === true,
      scripts: host?.querySelectorAll("script").length,
      onerrorAttrs: host?.querySelectorAll("[onerror]").length,
      javascriptHrefs: host?.querySelectorAll('a[href^="javascript:"]').length,
      linkTarget: link?.getAttribute("target") ?? null,
      iframes: host?.querySelectorAll("iframe").length,
      circles: host?.querySelectorAll("svg circle").length,
    };
  });

  report(
    name,
    "sanitizer",
    [
      ["no injected script ran", policy.executed === false],
      ["<script> stripped, in HTML and SVG", policy.scripts === 0],
      ["event-handler attributes stripped", policy.onerrorAttrs === 0],
      ["javascript: URLs stripped", policy.javascriptHrefs === 0],
      ["link target preserved", policy.linkTarget === "_blank"],
      ["iframe preserved", policy.iframes === 1],
      ["harmless SVG sibling preserved", policy.circles === 1],
    ],
    policy,
  );

  await browser.close();
}

fs.rmSync(bundlePath, { force: true });
fs.rmSync(cssPath, { force: true });
console.log(
  failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECKS FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
