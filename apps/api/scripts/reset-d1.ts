#!/usr/bin/env bun

import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const repoRoot = path.resolve(scriptsDir, "..", "..", "..");
const apiDir = path.join(repoRoot, "apps", "api");
const stateDir = path.join(apiDir, ".wrangler", "state");

function runStep(command: string, args: string[], cwd = apiDir) {
  const label = `${command} ${args.join(" ")}`.trim();
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${label}`);
  }
}

function removeStateDir() {
  if (existsSync(stateDir)) {
    console.log(`→ Removing ${path.relative(repoRoot, stateDir)}`);
    rmSync(stateDir, { recursive: true, force: true });
  } else {
    console.log("↷ No local D1 state directory found; skipping cleanup");
  }
}

function applyMigrations() {
  console.log("→ Applying D1 migrations locally");
  runStep("wrangler", ["d1", "migrations", "apply", "APP_DB", "--local"]);
}

function main() {
  removeStateDir();
  applyMigrations();
  console.log("✓ Local D1 reset complete");
}

main();
