import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const reportDir = path.join(rootDir, "artifacts/licenses/rust");
const maxBuffer = 128 * 1024 * 1024;
const allowedLicenses = new Set(
  Array.from(
    readFileSync(path.join(rootDir, "deny.toml"), "utf8").matchAll(
      /"([^"]+)"/gu,
    ),
    (match) => match[1],
  ),
);

mkdirSync(reportDir, { recursive: true });

// Directories that never hold a first-party manifest we own but do hold many
// nested Cargo.toml files (build artifacts, vendored deps). Skipping them keeps
// the walk fast and the manifest set to crates we actually ship.
const SKIP_DIRS = new Set(["target", "node_modules", ".git"]);

// Discover Cargo manifests with a plain filesystem walk rather than shelling out
// to ripgrep: the CI runner installs cargo-deny but not necessarily `rg`, and a
// missing tool used to surface as an opaque write() crash further down.
function findCargoManifests(searchDirs) {
  const manifests = [];
  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(absDir, entry.name));
        }
      } else if (entry.isFile() && entry.name === "Cargo.toml") {
        manifests.push(path.relative(rootDir, path.join(absDir, entry.name)));
      }
    }
  };
  for (const searchDir of searchDirs) {
    walk(path.join(rootDir, searchDir));
  }
  return manifests;
}

// Run cargo-deny and fail loudly if the process never launched. spawnSync
// returns null stdout/stderr when the binary is missing or the process is
// killed; writing that null downstream throws an opaque "write() expects a
// string" error that hides the real cause (a missing cargo-deny on PATH). A
// non-zero exit with real output is a genuine license finding, not a launch
// failure, so it passes through to the summary logic below.
function runCargoDeny(args, manifestPath) {
  const result = spawnSync("cargo", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer,
  });
  if (result.error || result.stdout === null) {
    const reason = result.error ? result.error.message : "no output captured";
    console.error(
      `Failed to run \`cargo ${args.join(" ")}\` for ${manifestPath}: ${reason}`,
    );
    console.error(
      "Ensure cargo-deny is installed (cargo install cargo-deny) and on PATH.",
    );
    process.exit(1);
  }
  return result;
}

const manifestPaths = findCargoManifests(["apps", "crates"])
  .filter((manifestPath) =>
    existsSync(path.join(rootDir, path.dirname(manifestPath), "Cargo.lock")),
  )
  .sort((left, right) => left.localeCompare(right));

const summary = [];
let failedChecks = 0;

for (const manifestPath of manifestPaths) {
  const manifestKey = path.dirname(manifestPath).replaceAll(path.sep, "__");
  const manifestReportDir = path.join(reportDir, manifestKey);
  mkdirSync(manifestReportDir, { recursive: true });

  const listResult = runCargoDeny(
    [
      "deny",
      "--manifest-path",
      manifestPath,
      "list",
      "-c",
      "deny.toml",
      "-f",
      "json",
    ],
    manifestPath,
  );

  writeFileSync(path.join(manifestReportDir, "list.json"), listResult.stdout);
  if (listResult.stderr) {
    writeFileSync(
      path.join(manifestReportDir, "list.stderr.log"),
      listResult.stderr,
    );
  }

  const checkResult = runCargoDeny(
    [
      "deny",
      "--manifest-path",
      manifestPath,
      "check",
      "-c",
      "deny.toml",
      "--hide-inclusion-graph",
      "licenses",
    ],
    manifestPath,
  );

  const combinedCheckLog = [checkResult.stdout, checkResult.stderr]
    .filter(Boolean)
    .join("\n");
  writeFileSync(path.join(manifestReportDir, "check.log"), combinedCheckLog);

  let licenses = [];
  let unlicensed = [];
  let blockedLicenses = [];

  if (listResult.status === 0) {
    const parsed = JSON.parse(listResult.stdout);
    licenses = parsed.licenses.map(([license]) => license).sort();
    unlicensed = parsed.unlicensed ?? [];
    // Informational only: flat token list ignores SPDX OR/AND, so a dual-licensed
    // crate (e.g. "MIT OR Apache-2.0 OR LGPL-2.1") surfaces its copyleft arm here
    // even though a permissive arm satisfies the policy. Never gate on this.
    blockedLicenses = licenses.filter(
      (license) => !allowedLicenses.has(license),
    );
  }

  // cargo-deny is authoritative: it evaluates each crate's full SPDX expression
  // against deny.toml (OR/AND/WITH aware). Trust its verdict rather than the
  // naive token list, otherwise permissively-satisfiable crates false-fail.
  const manifestOk = listResult.status === 0 && checkResult.status === 0;

  summary.push({
    manifest: manifestPath,
    listOk: listResult.status === 0,
    checkOk: manifestOk,
    cargoDenyCheckOk: checkResult.status === 0,
    licenses,
    blockedLicenses,
    unlicensed,
    reportDir: path.relative(rootDir, manifestReportDir),
  });

  if (!manifestOk) {
    failedChecks += 1;
  }
}

writeFileSync(
  path.join(reportDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

console.log(
  `Rust licenses: scanned ${summary.length} manifests. Reports written to ${path.relative(rootDir, reportDir)}.`,
);

const failures = summary.filter((entry) => !entry.listOk || !entry.checkOk);
if (failures.length === 0) {
  console.log("Rust license check passed.");
  process.exit(0);
}

console.error("Rust license review required for:");
for (const failure of failures) {
  const detail =
    failure.blockedLicenses.length > 0
      ? failure.blockedLicenses.join(", ")
      : "see check.log";
  console.error(`- ${failure.manifest}: ${detail} (${failure.reportDir})`);
}

process.exit(1);
