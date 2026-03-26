#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");

const defaultTargets = [
  "apps/desktop-capture/package.json",
  "apps/desktop/package.json",
];

const args = process.argv.slice(2);
let explicitVersion;
const targetArgs = [];
let dryRun = false;
let verbose = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === "--dry-run" || arg === "--dry") {
    dryRun = true;
    continue;
  }

  if (arg === "--verbose" || arg === "-v") {
    verbose = true;
    continue;
  }

  if (arg === "--version" || arg === "-V") {
    if (i + 1 >= args.length) {
      console.error("Missing value for --version option.");
      process.exit(1);
    }
    explicitVersion = args[i + 1];
    i += 1;
    continue;
  }

  if (arg.startsWith("--version=")) {
    explicitVersion = arg.split("=")[1];
    continue;
  }

  if (arg === "--target" || arg === "-t" || arg === "--file") {
    if (i + 1 >= args.length) {
      console.error("Missing value for --target option.");
      process.exit(1);
    }
    targetArgs.push(args[i + 1]);
    i += 1;
    continue;
  }

  if (arg.startsWith("--target=")) {
    targetArgs.push(arg.split("=")[1]);
    continue;
  }

  if (arg === "--all") {
    targetArgs.push(...defaultTargets);
    continue;
  }

  if (!explicitVersion) {
    explicitVersion = arg;
  } else {
    targetArgs.push(arg);
  }
}

function normaliseVersion(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutRef = trimmed.replace(/^refs\/tags\//, "");
  const semverCandidate = withoutRef.startsWith("v")
    ? withoutRef.slice(1)
    : withoutRef;
  const semverPattern =
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!semverPattern.test(semverCandidate)) {
    return null;
  }
  const tag = withoutRef.startsWith("v") ? withoutRef : `v${semverCandidate}`;
  return { semver: semverCandidate, tag };
}

function readBranchVersion() {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();

    const patterns = [
      /v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/,
      /v[0-9]+-[0-9]+-[0-9]+(?:-[0-9A-Za-z.-]+)?/,
    ];

    for (const pattern of patterns) {
      const match = branch.match(pattern);
      if (match) {
        const raw = match[0];
        if (raw.includes(".")) {
          return raw;
        }

        const segments = raw.slice(1).split("-");
        if (segments.length >= 3) {
          const base = segments.slice(0, 3).join(".");
          const remainder = segments.slice(3).join("-");
          return `v${base}${remainder ? `-${remainder}` : ""}`;
        }
        return raw;
      }
    }
  } catch {
    // ignore failures, fall back to other strategies
  }

  return null;
}

function readGitVersion() {
  const commands = [
    "git describe --tags --exact-match",
    "git describe --tags --abbrev=0",
  ];

  for (const command of commands) {
    try {
      return execSync(command, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      // ignore and try the next strategy
    }
  }

  return null;
}

const sources = [
  explicitVersion,
  process.env.APP_VERSION,
  process.env.DESKTOP_VERSION,
  process.env.RELEASE_VERSION,
  process.env.VERSION,
  process.env.GITHUB_REF_NAME,
  process.env.GITHUB_REF,
  process.env.GITHUB_HEAD_REF,
  readBranchVersion(),
  readGitVersion(),
];

let versionInfo;
for (const src of sources) {
  const info = normaliseVersion(src);
  if (info) {
    versionInfo = info;
    break;
  }
}

const targets = targetArgs.length ? targetArgs : defaultTargets;

if (!versionInfo) {
  for (const relative of targets) {
    try {
      const data = JSON.parse(
        readFileSync(path.resolve(repoRoot, relative), "utf8"),
      );
      const info = normaliseVersion(data.version);
      if (info) {
        versionInfo = info;
        if (verbose) {
          console.warn(
            `No external version provided; reusing ${info.tag} from ${relative}.`,
          );
        }
        break;
      }
    } catch {
      // ignore and keep searching
    }
  }
}

if (!versionInfo) {
  console.error(
    "Unable to determine version. Provide via --version, APP_VERSION, or ensure there is a git tag like v0.1.0.",
  );
  process.exit(1);
}

const semver = versionInfo.semver;

function detectIndent(text) {
  const match = text.match(/^[\t ]+(?=")/m);
  if (match) {
    const whitespace = match[0];
    if (whitespace.includes("\t")) return "\t";
    const spaces = whitespace.replace(/\t/g, "");
    if (spaces.length > 0) {
      return spaces.length > 10 ? "  " : " ".repeat(spaces.length);
    }
  }
  return "  ";
}

function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

let updatedCount = 0;

for (const relative of targets) {
  const absolute = path.resolve(repoRoot, relative);
  let original;
  try {
    original = readFileSync(absolute, "utf8");
  } catch (error) {
    console.error(`Failed to read ${relative}: ${error.message}`);
    process.exitCode = 1;
    continue;
  }

  let json;
  try {
    json = JSON.parse(original);
  } catch (error) {
    console.error(`Invalid JSON in ${relative}: ${error.message}`);
    process.exitCode = 1;
    continue;
  }

  const previous = json.version;
  if (previous === semver) {
    if (verbose) {
      console.log(`${relative} already at ${semver}`);
    }
    continue;
  }

  json.version = semver;

  const indent = detectIndent(original);
  const newline = detectNewline(original);
  const serialized = JSON.stringify(json, null, indent) + "\n";
  const finalText =
    newline === "\n" ? serialized : serialized.replace(/\n/g, newline);

  if (!dryRun) {
    writeFileSync(absolute, finalText);
  }

  updatedCount += 1;
  console.log(
    `${dryRun ? "Would update" : "Updated"} ${relative}: ${previous ?? "undefined"} → ${semver}`,
  );
}

if (updatedCount === 0 && verbose) {
  console.log(`No files required version update (target ${semver}).`);
}
