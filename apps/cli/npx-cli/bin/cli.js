#!/usr/bin/env node
"use strict";

const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const {
  assertPublicUrlConfigured,
  getPlatformDir,
  getBinaryName,
  R2_PUBLIC_URL,
} = require("./platform");

const platformDir = getPlatformDir();
const extractDir = path.join(__dirname, "..", "dist", platformDir);

fs.mkdirSync(extractDir, { recursive: true });

function download(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return download(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

async function ensureBinaryZip(baseName) {
  const zipPath = path.join(extractDir, `${baseName}.zip`);
  if (fs.existsSync(zipPath)) return;

  assertPublicUrlConfigured();

  const version = require("../package.json").version;
  const url = `${R2_PUBLIC_URL}/releases/v${version}/${platformDir}/${baseName}.zip`;
  console.log("Binary not found locally. Downloading from R2...");

  const res = await download(url);
  const file = fs.createWriteStream(zipPath);
  await new Promise((resolve, reject) => {
    res.pipe(file);
    file.on("finish", () => file.close(resolve));
    file.on("error", (err) => {
      fs.unlink(zipPath, () => {});
      reject(err);
    });
  });
  console.log("Download complete.");
}

function extractAndRun(baseName, launch) {
  const binName = getBinaryName(baseName);
  const binPath = path.join(extractDir, binName);
  const zipPath = path.join(extractDir, `${baseName}.zip`);

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
    console.error(`Current platform: ${platformDir}`);
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

  return launch(binPath);
}

const cliVersion = require("../package.json").version;
console.log(`Starting chro v${cliVersion}...`);

const args = process.argv.slice(2);

ensureBinaryZip("chro-server")
  .then(() => {
    extractAndRun("chro-server", (binPath) => {
      const proc = spawn(binPath, args, { stdio: "inherit" });
      proc.on("exit", (code) => process.exit(code || 0));
      proc.on("error", (error) => {
        console.error("failed to launch chro-server:", error.message);
        process.exit(1);
      });

      if (process.platform !== "win32") {
        process.on("SIGINT", () => proc.kill("SIGINT"));
        process.on("SIGTERM", () => proc.kill("SIGTERM"));
      }
    });
  })
  .catch((error) => {
    console.error(`Failed to obtain chro binary: ${error.message}`);
    console.error("Please check your network connection and try again.");
    process.exit(1);
  });
