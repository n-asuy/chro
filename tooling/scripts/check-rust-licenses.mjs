import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const reportDir = path.join(rootDir, "artifacts/licenses/rust");
const maxBuffer = 128 * 1024 * 1024;
const allowedLicenses = new Set(
  Array.from(
    readFileSync(path.join(rootDir, "deny.toml"), "utf8").matchAll(/"([^"]+)"/gu),
    (match) => match[1],
  ),
);

mkdirSync(reportDir, { recursive: true });

const manifestsResult = spawnSync(
  "rg",
  ["--files", "-g", "Cargo.toml", "apps", "crates"],
  {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer,
  },
);

if (manifestsResult.status !== 0) {
  process.stderr.write(manifestsResult.stderr || manifestsResult.stdout);
  process.exit(manifestsResult.status ?? 1);
}

const manifestPaths = manifestsResult.stdout
  .split(/\r?\n/u)
  .filter(Boolean)
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

  const listResult = spawnSync(
    "cargo",
    ["deny", "--manifest-path", manifestPath, "list", "-c", "deny.toml", "-f", "json"],
    {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer,
    },
  );

  writeFileSync(path.join(manifestReportDir, "list.json"), listResult.stdout);
  if (listResult.stderr) {
    writeFileSync(path.join(manifestReportDir, "list.stderr.log"), listResult.stderr);
  }

  const checkResult = spawnSync(
    "cargo",
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
    {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer,
    },
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
    blockedLicenses = licenses.filter((license) => !allowedLicenses.has(license));
  }

  const manifestOk =
    listResult.status === 0 &&
    checkResult.status === 0 &&
    blockedLicenses.length === 0 &&
    unlicensed.length === 0;

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
