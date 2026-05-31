import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const repoRoot = resolve(mobileRoot, "../..");
const iosRoot = resolve(mobileRoot, "ios");
const iosOnly = process.argv.includes("--ios-only");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? mobileRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    cwd: mobileRoot,
    stdio: "ignore",
  });

  return result.status === 0;
}

if (!iosOnly) {
  run("bun", ["install"], { cwd: repoRoot });
}

if (process.platform !== "darwin") {
  console.log("Skipping iOS pods: CocoaPods setup only runs on macOS.");
  process.exit(0);
}

if (!existsSync(resolve(iosRoot, "Podfile"))) {
  console.log("Skipping iOS pods: ios/Podfile was not found.");
  process.exit(0);
}

if (!commandExists("bundle")) {
  console.error(
    "Bundler is required for iOS setup. Install it with: gem install bundler",
  );
  process.exit(1);
}

run("bundle", ["install"], { cwd: iosRoot });
run("bundle", ["exec", "pod", "install"], { cwd: iosRoot });
