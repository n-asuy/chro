import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const electronDir = path.join(projectDir, "electron");
const outDir = path.join(projectDir, "dist-electron");

const sharedOptions = {
  bundle: true,
  platform: "node",
  target: "es2022",
  format: "cjs",
  outdir: outDir,
  external: ["electron"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

await Promise.all([
  build({
    ...sharedOptions,
    entryPoints: [path.join(electronDir, "main.ts")],
  }),
  build({
    ...sharedOptions,
    entryPoints: [path.join(electronDir, "preload.ts")],
  }),
]);
