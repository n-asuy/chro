import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const reportDir = path.join(rootDir, "artifacts/licenses/js");
const policyPath = path.join(rootDir, "tooling/licenses/js-policy.json");

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
mkdirSync(reportDir, { recursive: true });

const result = spawnSync(
  "npx",
  [
    "--yes",
    "license-checker",
    "--json",
    "--start",
    rootDir,
    "--relativeLicensePath",
    "--unknown",
    "--excludePrivatePackages",
  ],
  {
    cwd: "/tmp",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const rawInventory = JSON.parse(result.stdout);
writeFileSync(
  path.join(reportDir, "raw.json"),
  `${JSON.stringify(rawInventory, null, 2)}\n`,
);

const normalizedInventory = Object.entries(rawInventory)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([pkg, meta]) => {
    const detectedLicense = meta.licenses ?? "UNKNOWN";
    const override = policy.overrides[pkg];
    const effectiveLicense = override?.license ?? detectedLicense;
    const allowed = policy.allowedLicenses.includes(effectiveLicense);

    return {
      package: pkg,
      detectedLicense,
      effectiveLicense,
      allowed,
      overrideReason: override?.reason ?? null,
      reviewReason: allowed
        ? null
        : policy.blockedLicenseNotes[effectiveLicense] ??
          `License ${effectiveLicense} is not on the approved allowlist.`,
      repository: meta.repository ?? null,
      licenseFile: meta.licenseFile ?? null,
      path: meta.path ?? null,
    };
  });

writeFileSync(
  path.join(reportDir, "normalized.json"),
  `${JSON.stringify(normalizedInventory, null, 2)}\n`,
);

const uniqueLicenses = normalizedInventory.reduce((counts, entry) => {
  counts[entry.effectiveLicense] = (counts[entry.effectiveLicense] ?? 0) + 1;
  return counts;
}, {});

const blockedPackages = normalizedInventory.filter((entry) => !entry.allowed);
const overridesApplied = normalizedInventory.filter(
  (entry) => entry.overrideReason !== null,
);

const summary = {
  scannedPackages: normalizedInventory.length,
  overridesApplied: overridesApplied.length,
  uniqueLicenses: Object.entries(uniqueLicenses).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  ),
  blockedPackages,
};

writeFileSync(
  path.join(reportDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

console.log(
  `JS licenses: scanned ${summary.scannedPackages} packages, applied ${summary.overridesApplied} overrides.`,
);
console.log(`JS license reports written to ${path.relative(rootDir, reportDir)}`);

if (blockedPackages.length === 0) {
  console.log("JS license check passed.");
  process.exit(0);
}

console.error("JS license review required for:");
for (const entry of blockedPackages) {
  console.error(
    `- ${entry.package}: ${entry.effectiveLicense} (${entry.reviewReason})`,
  );
}

process.exit(1);
