#!/usr/bin/env node
"use strict";

const { execSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const os = require("os");
const {
  assertPublicUrlConfigured,
  getPlatformDir,
  getBinaryName,
  R2_PUBLIC_URL,
} = require("./platform");

const CACHE_DIR = path.join(os.homedir(), ".chro", "bin");
const LOCAL_DIST_DIR = path.join(__dirname, "..", "dist");
const LOCAL_DEV_MODE =
  fs.existsSync(LOCAL_DIST_DIR) || process.env.CHRO_LOCAL === "1";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return fetchJson(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Failed to parse JSON from ${url}`));
          }
        });
      })
      .on("error", reject);
  });
}

function downloadFile(url, destPath, expectedSha256) {
  const tempPath = destPath + ".tmp";
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tempPath);
    const hash = crypto.createHash("sha256");

    const cleanup = () => {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    };

    const client = url.startsWith("https") ? https : http;
    client
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          file.close();
          cleanup();
          return downloadFile(res.headers.location, destPath, expectedSha256)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 200) {
          file.close();
          cleanup();
          return reject(
            new Error(`HTTP ${res.statusCode} downloading ${url}`),
          );
        }

        res.on("data", (chunk) => {
          hash.update(chunk);
        });
        res.pipe(file);

        file.on("finish", () => {
          file.close();
          const actualSha256 = hash.digest("hex");
          if (expectedSha256 && actualSha256 !== expectedSha256) {
            cleanup();
            reject(
              new Error(
                `Checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`,
              ),
            );
          } else {
            try {
              fs.renameSync(tempPath, destPath);
              resolve(destPath);
            } catch (err) {
              cleanup();
              reject(err);
            }
          }
        });
      })
      .on("error", (err) => {
        file.close();
        cleanup();
        reject(err);
      });
  });
}

async function ensureBinaryZip(platformDir, binaryName) {
  // Local dev mode: use binaries from npx-cli/dist/
  if (LOCAL_DEV_MODE) {
    const localZipPath = path.join(
      LOCAL_DIST_DIR,
      platformDir,
      `${binaryName}.zip`,
    );
    if (fs.existsSync(localZipPath)) {
      return localZipPath;
    }
    throw new Error(
      `Local binary not found: ${localZipPath}\n` +
        "Run ./local-build.sh first to build the binaries.",
    );
  }

  assertPublicUrlConfigured();

  const version = require("../package.json").version;
  const tag = `v${version}`;
  const cacheDir = path.join(CACHE_DIR, tag, platformDir);
  const zipPath = path.join(cacheDir, `${binaryName}.zip`);

  if (fs.existsSync(zipPath)) return zipPath;

  fs.mkdirSync(cacheDir, { recursive: true });

  console.log("Fetching binary manifest...");
  const manifest = await fetchJson(
    `${R2_PUBLIC_URL}/releases/${tag}/manifest.json`,
  );
  const binaryInfo = manifest.platforms?.[platformDir]?.[binaryName];

  if (!binaryInfo) {
    throw new Error(
      `Binary ${binaryName} not available for ${platformDir}`,
    );
  }

  const url = `${R2_PUBLIC_URL}/releases/${tag}/${platformDir}/${binaryName}.zip`;
  console.log(`Downloading binary for ${platformDir}...`);
  await downloadFile(url, zipPath, binaryInfo.sha256);
  console.log("Download complete. Checksum verified.");

  return zipPath;
}

function extractAndRun(zipPath, extractDir, baseName, args) {
  const binName = getBinaryName(baseName);
  const binPath = path.join(extractDir, binName);

  if (fs.existsSync(binPath)) {
    try {
      fs.unlinkSync(binPath);
    } catch (err) {
      if (process.env.CHRO_DEBUG) {
        console.warn(`Warning: Could not delete existing binary: ${err.message}`);
      }
    }
  }

  if (!fs.existsSync(zipPath)) {
    console.error(`${baseName}.zip not found at: ${zipPath}`);
    process.exit(1);
  }

  const unzipCmd =
    process.platform === "win32"
      ? `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`
      : `unzip -qq -o "${zipPath}" -d "${extractDir}"`;

  try {
    execSync(unzipCmd, { stdio: "inherit" });
  } catch (err) {
    console.error("Extraction failed:", err.message);
    process.exit(1);
  }

  if (!fs.existsSync(binPath)) {
    console.error(`Extracted binary not found at: ${binPath}`);
    console.error("This usually indicates a corrupt download. Please reinstall.");
    process.exit(1);
  }

  if (process.platform !== "win32") {
    try {
      fs.chmodSync(binPath, 0o755);
    } catch {}
  }

  const proc = spawn(binPath, args, { stdio: "inherit" });
  proc.on("exit", (code) => process.exit(code || 0));
  proc.on("error", (error) => {
    console.error("Failed to launch Chro:", error.message);
    process.exit(1);
  });

  if (process.platform !== "win32") {
    process.on("SIGINT", () => proc.kill("SIGINT"));
    process.on("SIGTERM", () => proc.kill("SIGTERM"));
  }
}

const cliVersion = require("../package.json").version;
const platformDir = getPlatformDir();
const args = process.argv.slice(2);

if (args.length === 1 && ["-v", "-V", "--version"].includes(args[0])) {
  console.log(`chro ${cliVersion}`);
  process.exit(0);
}

console.log(`Starting chro v${cliVersion}...`);

ensureBinaryZip(platformDir, "chro-server")
  .then((zipPath) => {
    const extractDir = path.dirname(zipPath);
    extractAndRun(zipPath, extractDir, "chro-server", args);
  })
  .catch((error) => {
    console.error(`Failed to obtain chro binary: ${error.message}`);
    console.error("Please check your network connection and try again.");
    process.exit(1);
  });
