#!/usr/bin/env node
"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  getPlatformDir,
  hasConfiguredPublicUrl,
  R2_PUBLIC_URL,
} = require("./platform");

const version = require("../package.json").version;
const platformDir = getPlatformDir();
const distDir = path.join(__dirname, "..", "dist", platformDir);
const zipPath = path.join(distDir, "chro-server.zip");

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

async function main() {
  if (!hasConfiguredPublicUrl()) {
    console.warn("chro: R2 public URL is not configured");
    console.warn("chro: binary will be downloaded on first run if R2_PUBLIC_URL is set");
    return;
  }

  if (fs.existsSync(zipPath)) {
    console.log(`chro: binary already present at ${zipPath}, skipping download`);
    return;
  }

  const url = `${R2_PUBLIC_URL}/releases/v${version}/${platformDir}/chro-server.zip`;
  console.log(`chro: downloading binary for ${platformDir}...`);

  try {
    fs.mkdirSync(distDir, { recursive: true });
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

    console.log("chro: binary downloaded successfully");
  } catch (err) {
    console.warn(`chro: postinstall download failed: ${err.message}`);
    console.warn("chro: binary will be downloaded on first run");
    try {
      fs.unlinkSync(zipPath);
    } catch {}
  }
}

main();
