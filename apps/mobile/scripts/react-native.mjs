import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const iosRoot = resolve(mobileRoot, "ios");
const [command, ...passthroughArgs] = process.argv.slice(2);
const defaultPort = process.env.CHRO_MOBILE_PORT ?? "8090";
const commandsWithPort = new Set(["start", "run-ios", "run-android"]);
const commandsThatNeedMetro = new Set(["run-ios", "run-android"]);

if (!command) {
  console.error("Usage: bun ./scripts/react-native.mjs <command> [...args]");
  process.exit(1);
}

const hasPort = passthroughArgs.some(
  (arg) => arg === "--port" || arg.startsWith("--port="),
);
const args = [command, ...passthroughArgs];

if (commandsWithPort.has(command) && !hasPort) {
  args.push("--port", defaultPort);
}

const hasNoPackager = passthroughArgs.includes("--no-packager");

if (commandsThatNeedMetro.has(command) && !hasNoPackager) {
  args.push("--no-packager");
}

function runSetupIosIfNeeded() {
  if (process.platform !== "darwin") {
    return;
  }

  const podfileLock = resolve(iosRoot, "Podfile.lock");
  const manifestLock = resolve(iosRoot, "Pods/Manifest.lock");
  const isSynced =
    existsSync(podfileLock) &&
    existsSync(manifestLock) &&
    readFileSync(podfileLock, "utf8") === readFileSync(manifestLock, "utf8");

  if (isSynced) {
    return;
  }

  console.log("iOS pods are out of sync. Running bun setup:ios first.");
  const result = spawnSync("bun", ["./scripts/setup.mjs", "--ios-only"], {
    cwd: mobileRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (command === "run-ios") {
  runSetupIosIfNeeded();
}

function checkMetro(port) {
  return new Promise((resolveStatus) => {
    const request = http.get(
      {
        host: "localhost",
        path: "/status",
        port,
        timeout: 1000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolveStatus(body.trim() === "packager-status:running");
        });
      },
    );

    request.on("error", () => {
      resolveStatus(false);
    });
    request.on("timeout", () => {
      request.destroy();
      resolveStatus(false);
    });
  });
}

async function waitForMetro(port) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (await checkMetro(port)) {
      return;
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  console.error(`Metro did not become ready on port ${port}.`);
  process.exit(1);
}

async function ensureMetro() {
  if (await checkMetro(defaultPort)) {
    return;
  }

  const logDir = resolve(mobileRoot, ".metro");
  mkdirSync(logDir, { recursive: true });
  const stdout = openSync(resolve(logDir, "metro.log"), "a");
  const stderr = openSync(resolve(logDir, "metro.error.log"), "a");

  console.log(`Starting Metro on port ${defaultPort}.`);
  const child = spawn("react-native", ["start", "--port", defaultPort], {
    cwd: mobileRoot,
    detached: true,
    env: {
      ...process.env,
      RCT_METRO_PORT: defaultPort,
    },
    stdio: ["ignore", stdout, stderr],
  });
  child.unref();

  await waitForMetro(defaultPort);
}

if (commandsThatNeedMetro.has(command)) {
  await ensureMetro();
}

const result = spawnSync("react-native", args, {
  cwd: mobileRoot,
  env: {
    ...process.env,
    RCT_METRO_PORT: defaultPort,
  },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
