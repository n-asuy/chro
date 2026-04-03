#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");

const packageJson = require("../package.json");

function normalizePublicUrl(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

const R2_PUBLIC_URL = normalizePublicUrl(
  process.env.R2_PUBLIC_URL || packageJson.config?.r2PublicUrl,
);

function getEffectiveArch() {
  const platform = process.platform;
  const nodeArch = process.arch;

  if (platform === "darwin") {
    if (nodeArch === "arm64") return "arm64";
    try {
      const translated = execSync("sysctl -in sysctl.proc_translated", {
        encoding: "utf8",
      }).trim();
      if (translated === "1") return "arm64";
    } catch {
      // Ignore and assume Intel.
    }
    return "x64";
  }

  if (/arm/i.test(nodeArch)) return "arm64";

  if (platform === "win32") {
    const pa = process.env.PROCESSOR_ARCHITECTURE || "";
    const paw = process.env.PROCESSOR_ARCHITEW6432 || "";
    if (/arm/i.test(pa) || /arm/i.test(paw)) return "arm64";
  }

  return "x64";
}

const PLATFORM_MAP = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "windows-x64",
  "win32-arm64": "windows-arm64",
  "darwin-x64": "macos-x64",
  "darwin-arm64": "macos-arm64",
};

function getPlatformDir() {
  const key = `${process.platform}-${getEffectiveArch()}`;
  const dir = PLATFORM_MAP[key];

  if (!dir) {
    console.error(`Unsupported platform: ${key}`);
    process.exit(1);
  }

  return dir;
}

function getBinaryName(base) {
  return process.platform === "win32" ? `${base}.exe` : base;
}

function assertPublicUrlConfigured() {
  if (R2_PUBLIC_URL.length > 0) return;

  console.error("chro: R2 public URL is not configured.");
  console.error(
    "Set R2_PUBLIC_URL or populate package.json config.r2PublicUrl before publishing.",
  );
  process.exit(1);
}

module.exports = {
  assertPublicUrlConfigured,
  getEffectiveArch,
  getPlatformDir,
  getBinaryName,
  R2_PUBLIC_URL,
};
