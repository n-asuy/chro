import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, "..");
const crateRoot = path.resolve(projectRoot, "../../crates/napi-filesystem");
const manifestPath = path.join(crateRoot, "Cargo.toml");
const targetDir = path.join(crateRoot, "target", "debug");
const outputDir = path.join(projectRoot, ".native");
const outputPath = path.join(outputDir, "chro-filesystem.node");

const crateName = "chro_napi_filesystem";

const platformLibraryName = () => {
  if (process.platform === "darwin") {
    return `lib${crateName}.dylib`;
  }
  if (process.platform === "win32") {
    return `${crateName}.dll`;
  }
  return `lib${crateName}.so`;
};

if (process.env.CHRO_ENABLE_NAPI_FS === "0") {
  console.log("[native-fs] Build skipped (CHRO_ENABLE_NAPI_FS=0)");
  process.exit(0);
}

const build = spawnSync("cargo", ["build", "--manifest-path", manifestPath], {
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const sourceLibPath = path.join(targetDir, platformLibraryName());
if (!fs.existsSync(sourceLibPath)) {
  console.error(`[native-fs] Native library not found: ${sourceLibPath}`);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(sourceLibPath, outputPath);

console.log(`[native-fs] Built: ${outputPath}`);
