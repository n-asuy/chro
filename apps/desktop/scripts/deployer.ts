#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tauri replacement for the old electron-builder-driven deployer. The high
// level shape (parseArgs / package / release / tag / upload) is preserved so
// CI calling conventions stay the same. The interior switches to running
// `tauri build` and staging chro-server as a Tauri sidecar.

type Command = "package" | "release" | "upload" | "tag";

const PROJECT_NAMES = ["desktop"] as const;
type ProjectName = (typeof PROJECT_NAMES)[number];

interface Options {
  command: Command;
  version: string | null;
  tag: string | null;
  message: string | null;
  builderArgs: string[];
  projects: ProjectName[];
  skipSigning: boolean;
}

interface ProjectConfig {
  name: ProjectName;
  projectDir: string;
  packageJsonPath: string;
  packageJsonRelativePath: string;
  commitScope: string;
  fallbackProductName: string;
}

interface PackageInfo {
  name: string;
  version: string;
  productName: string;
}

interface ReleaseArtifact {
  project: ProjectName;
  path: string;
}

interface TauriBuildContext {
  /** human-readable label e.g. "macOS arm64" */
  label: string;
  /** rustup target triple, e.g. "aarch64-apple-darwin" */
  triple: string;
  /** bundle types passed to `tauri build --bundles` */
  bundles: string[];
  /** suffix appended to the staged chro-server binary name */
  binaryName: string;
  /** glob patterns matching artifacts in src-tauri/target/<triple>/release/bundle/ */
  artifactGlobs: RegExp[];
}

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..", "..");

const desktopProjectDir = path.join(repoRoot, "apps", "desktop");
const srcTauriDir = path.join(desktopProjectDir, "src-tauri");
const tauriBinariesDir = path.join(srcTauriDir, "binaries");
const tauriConfPath = path.join(srcTauriDir, "tauri.conf.json");
const tauriCargoTomlPath = path.join(srcTauriDir, "Cargo.toml");

const rustServerCrateDir = path.join(repoRoot, "crates", "server");
const rustServerBinaryBaseName = "chro-server";
const rustServerManifestPath = path.join(rustServerCrateDir, "Cargo.toml");

// The terminal CLI is staged as a second Tauri sidecar so agents launched by the
// bundled server can call `chro task ...` by bare name (the server prepends the
// sidecar dir to PATH via CHRO_CLI_DIR).
const cliCrateDir = path.join(repoRoot, "apps", "cli");
const cliBinaryBaseName = "chro";
const cliManifestPath = path.join(cliCrateDir, "Cargo.toml");
const npxCliPackageJsonPath = path.join(
  repoRoot,
  "apps",
  "cli",
  "npx-cli",
  "package.json",
);
const changelogPath = path.join(repoRoot, "CHANGELOG.md");

const ensuredRustTargets = new Set<string>();

function relativeToRepo(targetPath: string): string {
  return path.relative(repoRoot, targetPath) || ".";
}

const projectMetadata: Record<
  ProjectName,
  { commitScope: string; fallbackProductName: string }
> = {
  desktop: {
    commitScope: "desktop",
    fallbackProductName: "Chro",
  },
};

function getProjectConfig(name: ProjectName): ProjectConfig {
  const meta = projectMetadata[name];
  const projectDir = path.join(repoRoot, "apps", name);
  const packageJsonPath = path.join(projectDir, "package.json");
  return {
    name,
    projectDir,
    packageJsonPath,
    packageJsonRelativePath: relativeToRepo(packageJsonPath),
    commitScope: meta.commitScope,
    fallbackProductName: meta.fallbackProductName,
  };
}

function isProjectName(value: string): value is ProjectName {
  return PROJECT_NAMES.includes(value as ProjectName);
}

function parseArgs(rawArgs: string[]): Options {
  const args = [...rawArgs];
  let command: Command = "package";

  if (args[0] && !args[0].startsWith("--")) {
    const candidate = args.shift()!;
    if (
      candidate === "package" ||
      candidate === "release" ||
      candidate === "upload" ||
      candidate === "tag"
    ) {
      command = candidate;
    } else {
      throw new Error(`Unknown command: ${candidate}`);
    }
  }

  let builderArgs: string[] = [];
  const doubleDashIndex = args.indexOf("--");
  if (doubleDashIndex !== -1) {
    builderArgs = args.slice(doubleDashIndex + 1);
    args.length = doubleDashIndex;
  }

  const options: Options = {
    command,
    version: null,
    tag: null,
    message: null,
    builderArgs,
    projects: [...PROJECT_NAMES],
    skipSigning: false,
  };

  const expectValue = (name: string, index: number): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    return value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--version":
      case "-v":
        options.version = expectValue(arg, i);
        i += 1;
        break;
      case "--tag":
      case "-t":
        options.tag = expectValue(arg, i);
        i += 1;
        break;
      case "--message":
      case "-m":
        options.message = expectValue(arg, i);
        i += 1;
        break;
      case "--project":
      case "-p": {
        const projectValue = expectValue(arg, i);
        if (
          projectValue === "both" ||
          projectValue === "all" ||
          projectValue === "bundle"
        ) {
          options.projects = [...PROJECT_NAMES];
        } else if (isProjectName(projectValue)) {
          options.projects = [projectValue];
        } else {
          throw new Error(`Unsupported project: ${projectValue}`);
        }
        i += 1;
        break;
      }
      case "--skip-sign":
      case "--no-sign":
        options.skipSigning = true;
        break;
      default:
        throw new Error(`Unsupported option: ${arg}`);
    }
  }

  const dedupedProjects = new Set<ProjectName>(options.projects);
  options.projects = PROJECT_NAMES.filter((project) =>
    dedupedProjects.has(project),
  );

  if (options.projects.length === 0) {
    options.projects = [...PROJECT_NAMES];
  }

  return options;
}

function ensureGhRepoConfigured(command: Command) {
  if (command !== "release" && command !== "upload") {
    return;
  }
  const ghRepo = process.env.GH_REPO?.trim();
  if (!ghRepo) {
    throw new Error(
      "GH_REPO environment variable must be set (e.g. export GH_REPO=owner/repo) before running the release/upload command.",
    );
  }
  console.log(
    `Using GitHub repository ${ghRepo} (GH_REPO) for release artifacts.`,
  );
}

function extractChangelogEntry(version: string): string {
  const changelog = readFileSync(changelogPath, "utf8");
  const heading = `## ${version}`;
  const headingIndex = changelog.indexOf(heading);
  if (headingIndex === -1) {
    throw new Error(
      `CHANGELOG.md has no entry for version ${version}. Add a "${heading}" section before releasing.`,
    );
  }
  const afterHeading = changelog.slice(headingIndex + heading.length);
  const nextSection = afterHeading.indexOf("\n## ");
  const sectionBody = (
    nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection)
  ).trim();
  if (!sectionBody.includes("- ")) {
    throw new Error(
      `CHANGELOG.md entry for ${version} has no content. Add at least one "- " item.`,
    );
  }
  return sectionBody;
}

function updateCargoTomlVersion(manifestPath: string, newVersion: string) {
  const content = readFileSync(manifestPath, "utf8");
  const updated = content.replace(
    /^version\s*=\s*"[^"]*"/m,
    `version = "${newVersion}"`,
  );
  writeFileSync(manifestPath, updated, "utf8");
}

function updateTauriConfVersion(newVersion: string) {
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8")) as Record<
    string,
    unknown
  >;
  conf.version = newVersion;
  writeFileSync(tauriConfPath, `${JSON.stringify(conf, null, 2)}\n`, "utf8");
}

function updateNpxCliVersion(newVersion: string) {
  const pkg = JSON.parse(
    readFileSync(npxCliPackageJsonPath, "utf8"),
  ) as Record<string, unknown>;
  pkg.version = newVersion;
  writeFileSync(
    npxCliPackageJsonPath,
    `${JSON.stringify(pkg, null, 2)}\n`,
    "utf8",
  );
}

function updateCargoLock() {
  runCommand("cargo", ["check", "--manifest-path", rustServerManifestPath], {
    cwd: repoRoot,
  });
}

function commitUnifiedVersionBump(newVersion: string) {
  const paths = [
    relativeToRepo(path.join(desktopProjectDir, "package.json")),
    relativeToRepo(tauriConfPath),
    relativeToRepo(tauriCargoTomlPath),
    relativeToRepo(rustServerManifestPath),
    relativeToRepo(npxCliPackageJsonPath),
    relativeToRepo(path.join(rustServerCrateDir, "Cargo.lock")),
  ];
  runCommand("git", ["add", ...paths], { cwd: repoRoot });
  runCommand("git", ["commit", "-m", `release ${newVersion}`], {
    cwd: repoRoot,
  });
}

function readPackageInfo(config: ProjectConfig): PackageInfo {
  const pkg = JSON.parse(
    readFileSync(config.packageJsonPath, "utf8"),
  ) as Record<string, unknown>;
  const version = typeof pkg.version === "string" ? pkg.version : null;
  if (!version) {
    throw new Error(
      `Unable to read version from ${config.packageJsonRelativePath}`,
    );
  }
  const name = typeof pkg.name === "string" ? pkg.name : config.name;
  return { name, version, productName: config.fallbackProductName };
}

function normaliseVersionInput(raw: string): string {
  return raw.startsWith("v") ? raw.slice(1) : raw;
}

function assertSemver(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
}

function incrementPatchVersion(current: string): string {
  assertSemver(current);
  const [major, minor, patch] = current.split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function updatePackageVersion(config: ProjectConfig, newVersion: string) {
  const pkg = JSON.parse(
    readFileSync(config.packageJsonPath, "utf8"),
  ) as Record<string, unknown>;
  pkg.version = newVersion;
  writeFileSync(
    config.packageJsonPath,
    `${JSON.stringify(pkg, null, 2)}\n`,
    "utf8",
  );
}

interface RunOptions {
  cwd?: string;
  capture?: boolean;
  env?: Partial<NodeJS.ProcessEnv>;
}

function runCommand(
  command: string,
  args: string[],
  opts: RunOptions = {},
): { stdout: string } {
  const { cwd, capture = false, env } = opts;
  const displayCwd = cwd ? relativeToRepo(cwd) : relativeToRepo(process.cwd());
  const formattedArgs = args.map((value) =>
    value.includes(" ") ? `'${value}'` : value,
  );
  console.log(`$ (${displayCwd}) ${command} ${formattedArgs.join(" ")}`);

  const stdio = capture ? ["inherit", "pipe", "inherit"] : "inherit";
  const combinedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of Object.keys(combinedEnv)) {
    if (typeof combinedEnv[key] === "undefined") {
      delete combinedEnv[key];
    }
  }
  const result = spawnSync(command, args, {
    cwd,
    env: combinedEnv,
    stdio: stdio as any,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed with exit code ${result.status}: ${command} ${formattedArgs.join(" ")}`,
    );
  }
  return { stdout: capture && result.stdout ? result.stdout.toString() : "" };
}

function ensureCleanWorkingTree() {
  const { stdout } = runCommand("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    capture: true,
  });
  const changes = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (changes.length > 0) {
    throw new Error(
      `Working tree has uncommitted changes:\n${changes.join("\n")}`,
    );
  }
}

function ensureRustTarget(target: string) {
  if (ensuredRustTargets.has(target)) {
    return;
  }
  runCommand("rustup", ["target", "add", target], { cwd: repoRoot });
  ensuredRustTargets.add(target);
}

function detectBuildContexts(runArgs: string[]): TauriBuildContext[] {
  const wantMac = runArgs.includes("--mac");
  const wantWin = runArgs.includes("--win");
  const wantLinux = runArgs.includes("--linux");
  const wantArm = runArgs.includes("--arm64");
  const wantX64 = runArgs.includes("--x64");

  if (wantMac) {
    const archs: Array<{ triple: string; label: string }> = [];
    if (wantArm || (!wantArm && !wantX64)) {
      archs.push({ triple: "aarch64-apple-darwin", label: "macOS arm64" });
    }
    if (wantX64 || (!wantArm && !wantX64)) {
      archs.push({ triple: "x86_64-apple-darwin", label: "macOS x64" });
    }
    return archs.map(({ triple, label }) => ({
      label,
      triple,
      bundles: ["app", "dmg", "updater"],
      binaryName: rustServerBinaryBaseName,
      artifactGlobs: [
        /\.dmg$/i,
        /\.app\.tar\.gz$/i,
        /\.app\.tar\.gz\.sig$/i,
        /latest\.json$/i,
      ],
    }));
  }

  if (wantWin) {
    if (process.platform !== "win32") {
      throw new Error(
        "Windows builds require a Windows environment. Use GitHub Actions or a Windows machine.",
      );
    }
    return [
      {
        label: "Windows x64",
        triple: "x86_64-pc-windows-msvc",
        bundles: ["nsis", "updater"],
        binaryName: `${rustServerBinaryBaseName}.exe`,
        artifactGlobs: [/\.exe$/i, /\.zip$/i, /\.zip\.sig$/i, /latest\.json$/i],
      },
    ];
  }

  if (wantLinux) {
    return [
      {
        label: "Linux x64",
        triple: "x86_64-unknown-linux-gnu",
        bundles: ["appimage", "deb", "updater"],
        binaryName: rustServerBinaryBaseName,
        artifactGlobs: [
          /\.AppImage$/i,
          /\.AppImage\.tar\.gz$/i,
          /\.AppImage\.tar\.gz\.sig$/i,
          /\.deb$/i,
          /latest\.json$/i,
        ],
      },
    ];
  }

  // No platform flag: pick a sensible default for the current host.
  if (process.platform === "darwin") {
    return [
      {
        label: "macOS arm64",
        triple: "aarch64-apple-darwin",
        bundles: ["app", "dmg", "updater"],
        binaryName: rustServerBinaryBaseName,
        artifactGlobs: [
          /\.dmg$/i,
          /\.app\.tar\.gz$/i,
          /\.app\.tar\.gz\.sig$/i,
          /latest\.json$/i,
        ],
      },
      {
        label: "macOS x64",
        triple: "x86_64-apple-darwin",
        bundles: ["app", "dmg", "updater"],
        binaryName: rustServerBinaryBaseName,
        artifactGlobs: [
          /\.dmg$/i,
          /\.app\.tar\.gz$/i,
          /\.app\.tar\.gz\.sig$/i,
          /latest\.json$/i,
        ],
      },
    ];
  }
  if (process.platform === "win32") {
    return [
      {
        label: "Windows x64",
        triple: "x86_64-pc-windows-msvc",
        bundles: ["nsis", "updater"],
        binaryName: `${rustServerBinaryBaseName}.exe`,
        artifactGlobs: [/\.exe$/i, /\.zip$/i, /\.zip\.sig$/i, /latest\.json$/i],
      },
    ];
  }
  return [
    {
      label: "Linux x64",
      triple: "x86_64-unknown-linux-gnu",
      bundles: ["appimage", "deb", "updater"],
      binaryName: rustServerBinaryBaseName,
      artifactGlobs: [
        /\.AppImage$/i,
        /\.deb$/i,
        /\.AppImage\.tar\.gz$/i,
        /\.AppImage\.tar\.gz\.sig$/i,
        /latest\.json$/i,
      ],
    },
  ];
}

// The chro-server sidecar links libsqlite3-sys, which compiles SQLite's C code
// against the dynamic VC++ runtime by default. That binds the binary to
// VCRUNTIME140.dll, which is absent on clean Windows machines (it ships with the
// VC++ Redistributable, not Windows itself), so the sidecar fails to launch with
// "VCRUNTIME140.dll was not found". Statically linking the CRT embeds that
// runtime into the binary and removes the dependency; the cc crate picks up the
// matching /MT C runtime automatically once crt-static is set.
//
// This is scoped to the sidecar build only. The Tauri GUI binary is pure Rust
// (its runtime needs are satisfied by the OS-provided UCRT) and is built by a
// separate `tauri build` invocation, so it stays on the dynamic CRT — applying
// crt-static to a WebView2 process risks two CRT instances in one process.
// CARGO_TARGET_<triple>_RUSTFLAGS is target-gated, so macOS/Linux builds are
// untouched.
function rustServerBuildEnv(triple: string): NodeJS.ProcessEnv | undefined {
  if (triple !== "x86_64-pc-windows-msvc") {
    return undefined;
  }
  return {
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS:
      "-C target-feature=+crt-static",
  };
}

interface StandaloneBinarySpec {
  /** human-readable label e.g. "macOS arm64" */
  label: string;
  /** crate root whose `target/<triple>/release/` holds the built binary */
  crateDir: string;
  /** path to the crate's Cargo.toml */
  manifestPath: string;
  /** cargo `--bin` name and Tauri sidecar base name */
  baseName: string;
  /** rustup target triple */
  triple: string;
  /** whether the platform appends a `.exe` suffix */
  exe: boolean;
}

function buildAndStageStandaloneBinary(spec: StandaloneBinarySpec) {
  ensureRustTarget(spec.triple);
  console.log(`Building ${spec.baseName} (${spec.label})…`);
  runCommand(
    "cargo",
    [
      "build",
      "--release",
      "--manifest-path",
      spec.manifestPath,
      "--bin",
      spec.baseName,
      "--target",
      spec.triple,
    ],
    { cwd: repoRoot, env: rustServerBuildEnv(spec.triple) },
  );

  const binaryFileName = spec.exe ? `${spec.baseName}.exe` : spec.baseName;
  const sourcePath = path.join(
    spec.crateDir,
    "target",
    spec.triple,
    "release",
    binaryFileName,
  );
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Expected Rust binary at ${relativeToRepo(sourcePath)}, but it was not found.`,
    );
  }
  mkdirSync(tauriBinariesDir, { recursive: true });

  // Tauri sidecar naming convention: `<base>-<triple>[.exe]`.
  const stagedName = `${spec.baseName}-${spec.triple}${spec.exe ? ".exe" : ""}`;
  const destinationPath = path.join(tauriBinariesDir, stagedName);
  if (existsSync(destinationPath)) {
    rmSync(destinationPath, { force: true });
  }
  copyFileSync(sourcePath, destinationPath);
}

// Stage every sidecar the bundle ships: the local server and the terminal CLI.
function buildAndStageRustBinary(context: TauriBuildContext) {
  const exe = context.binaryName.endsWith(".exe");
  buildAndStageStandaloneBinary({
    label: context.label,
    crateDir: rustServerCrateDir,
    manifestPath: rustServerManifestPath,
    baseName: rustServerBinaryBaseName,
    triple: context.triple,
    exe,
  });
  buildAndStageStandaloneBinary({
    label: context.label,
    crateDir: cliCrateDir,
    manifestPath: cliManifestPath,
    baseName: cliBinaryBaseName,
    triple: context.triple,
    exe,
  });
}

function tauriBuildEnv(skipSigning: boolean): NodeJS.ProcessEnv | undefined {
  if (!skipSigning) {
    return undefined;
  }
  // `--skip-sign` only disables Apple code signing/notarization. Updater
  // artifact signing is independent and is disabled by runTauriBuild for local
  // unsigned builds, so leave TAURI_SIGNING_PRIVATE_KEY untouched for CI builds
  // that still provide it.
  return {
    APPLE_CERTIFICATE: undefined,
    APPLE_CERTIFICATE_PASSWORD: undefined,
    APPLE_SIGNING_IDENTITY: undefined,
    APPLE_ID: undefined,
    APPLE_PASSWORD: undefined,
    APPLE_APP_SPECIFIC_PASSWORD: undefined,
    APPLE_TEAM_ID: undefined,
  };
}

function bundleRootForContext(context: TauriBuildContext): string {
  return path.join(
    srcTauriDir,
    "target",
    context.triple,
    "release",
    "bundle",
  );
}

function cleanBundleArtifacts(context: TauriBuildContext) {
  rmSync(bundleRootForContext(context), { recursive: true, force: true });
}

function withUnsignedTauriConfig<T>(skipSigning: boolean, run: () => T): T {
  if (!skipSigning) {
    return run();
  }

  const originalConfig = readFileSync(tauriConfPath, "utf8");
  const conf = JSON.parse(originalConfig) as Record<string, unknown>;
  const bundle =
    typeof conf.bundle === "object" && conf.bundle !== null
      ? { ...(conf.bundle as Record<string, unknown>) }
      : {};

  conf.bundle = {
    ...bundle,
    createUpdaterArtifacts: false,
  };
  writeFileSync(tauriConfPath, `${JSON.stringify(conf, null, 2)}\n`, "utf8");

  try {
    return run();
  } finally {
    writeFileSync(tauriConfPath, originalConfig, "utf8");
  }
}

function runTauriBuild(
  context: TauriBuildContext,
  packageInfo: PackageInfo,
  skipSigning: boolean,
) {
  // The updater bundle (.app.tar.gz / .zip) is signed with
  // TAURI_SIGNING_PRIVATE_KEY. Local unsigned builds don't need the updater feed,
  // so keep only installable bundles and temporarily disable updater artifacts.
  const unsignedMacBuild =
    skipSigning && context.triple.includes("apple-darwin");
  const bundles = skipSigning
    ? context.bundles.filter((bundle) => bundle !== "updater")
    : context.bundles;
  const tauriBundles = unsignedMacBuild
    ? bundles.filter((bundle) => bundle !== "dmg")
    : bundles;
  const tauriArgs = [
    "tauri",
    "build",
    "--target",
    context.triple,
    "--bundles",
    tauriBundles.join(","),
  ];
  withUnsignedTauriConfig(skipSigning, () => {
    runCommand("bunx", tauriArgs, {
      cwd: desktopProjectDir,
      env: tauriBuildEnv(skipSigning),
    });
  });

  if (unsignedMacBuild && bundles.includes("dmg")) {
    createUnsignedMacDmg(context, packageInfo);
  }
}

function createUnsignedMacDmg(
  context: TauriBuildContext,
  packageInfo: PackageInfo,
) {
  const bundleRoot = bundleRootForContext(context);
  const appPath = path.join(
    bundleRoot,
    "macos",
    `${packageInfo.productName}.app`,
  );
  if (!existsSync(appPath)) {
    throw new Error(
      `Expected macOS app bundle at ${relativeToRepo(appPath)}, but it was not found.`,
    );
  }

  const dmgDir = path.join(bundleRoot, "dmg");
  const stageDir = path.join(dmgDir, "unsigned-stage");
  const dmgPath = path.join(
    dmgDir,
    `${packageInfo.productName}_${packageInfo.version}_${macDmgArchSuffix(
      context.triple,
    )}.dmg`,
  );
  const volumeName = path.basename(dmgPath, ".dmg");

  rmSync(stageDir, { recursive: true, force: true });
  rmSync(dmgPath, { force: true });
  mkdirSync(stageDir, { recursive: true });

  cpSync(appPath, path.join(stageDir, path.basename(appPath)), {
    recursive: true,
  });
  symlinkSync("/Applications", path.join(stageDir, "Applications"));

  try {
    runCommand(
      "hdiutil",
      [
        "create",
        "-volname",
        volumeName,
        "-srcfolder",
        stageDir,
        "-ov",
        "-format",
        "UDZO",
        dmgPath,
      ],
      { cwd: repoRoot },
    );
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

function macDmgArchSuffix(triple: string): string {
  if (triple === "aarch64-apple-darwin") {
    return "aarch64";
  }
  if (triple === "x86_64-apple-darwin") {
    return "x64";
  }
  return triple;
}

function collectBundleArtifacts(context: TauriBuildContext): string[] {
  // Tauri 2 writes outputs to <crate>/target/<triple>/release/bundle/<format>/.
  const bundleRoot = bundleRootForContext(context);
  if (!existsSync(bundleRoot)) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const matches = context.artifactGlobs.some((g) => g.test(entry.name));
        if (matches) {
          out.push(full);
        }
      }
    }
  };
  walk(bundleRoot);
  return out;
}

function packageDesktop(
  builderArgs: string[],
  packageInfo: PackageInfo,
  options: { skipSigning: boolean },
) {
  // Build the renderer once; Tauri's beforeBuildCommand also calls this but
  // running it here keeps `bun run build` reproducible across hosts.
  runCommand("bun", ["run", "build:vite"], { cwd: desktopProjectDir });

  const contexts = detectBuildContexts(builderArgs);
  const releaseDir = path.join(
    desktopProjectDir,
    "release",
    packageInfo.version,
  );
  if (existsSync(releaseDir)) {
    rmSync(releaseDir, { recursive: true, force: true });
  }
  mkdirSync(releaseDir, { recursive: true });

  // For multi-arch macOS we want to consolidate the per-arch latest.json into
  // a single feed manifest so the updater plugin gets one URL it can hit.
  const latestJsonByPlatform = new Map<
    string,
    Record<string, unknown>
  >();

  for (const ctx of contexts) {
    buildAndStageRustBinary(ctx);
    cleanBundleArtifacts(ctx);
    runTauriBuild(ctx, packageInfo, options.skipSigning);

    const artifacts = collectBundleArtifacts(ctx);
    if (artifacts.length === 0) {
      console.warn(`No artifacts produced for ${ctx.label}.`);
      continue;
    }
    for (const artifact of artifacts) {
      const base = path.basename(artifact);
      const target = path.join(releaseDir, prefixed(ctx, base));
      copyOrMoveArtifact(artifact, target);

      if (base === "latest.json") {
        const json = JSON.parse(readFileSync(target, "utf8")) as Record<
          string,
          unknown
        >;
        const platform = osPlatformKey(ctx.triple);
        const existing = latestJsonByPlatform.get(platform);
        latestJsonByPlatform.set(
          platform,
          mergeLatestJson(existing, json, ctx.triple),
        );
        // Remove the per-arch file; we'll write the merged one below.
        unlinkSync(target);
      }
    }
  }

  for (const [platform, manifest] of latestJsonByPlatform) {
    const filename = `latest-${platform}.json`;
    writeFileSync(
      path.join(releaseDir, filename),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
}

function copyOrMoveArtifact(source: string, target: string) {
  if (existsSync(target)) {
    rmSync(target, { force: true });
  }
  copyFileSync(source, target);
}

function prefixed(ctx: TauriBuildContext, base: string): string {
  // Disambiguate same-name artifacts (e.g. latest.json) per arch by prefixing
  // the triple. Final cross-arch merging happens after collection.
  if (base === "latest.json") {
    return `${ctx.triple}.${base}`;
  }
  return base;
}

function osPlatformKey(triple: string): string {
  if (triple.includes("apple-darwin")) return "darwin";
  if (triple.includes("windows")) return "windows";
  if (triple.includes("linux")) return "linux";
  return triple;
}

interface LatestJsonPlatform {
  signature?: string;
  url?: string;
  with_elevated_task?: boolean;
}

interface LatestJson {
  version?: string;
  notes?: string;
  pub_date?: string;
  platforms?: Record<string, LatestJsonPlatform>;
  // Tauri's manifest sometimes has only `signature` + `url` at the root for
  // single-platform builds, but the canonical form is `platforms`.
}

function mergeLatestJson(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  triple: string,
): Record<string, unknown> {
  const base = (existing ?? incoming) as LatestJson;
  const next = incoming as LatestJson;
  const platforms: Record<string, LatestJsonPlatform> = {
    ...(base.platforms ?? {}),
    ...(next.platforms ?? {}),
  };
  const archKey = tauriArchKey(triple);
  if (archKey && next.platforms?.[Object.keys(next.platforms)[0]]) {
    // If the incoming json only declared one platform, re-key it under the
    // arch-specific name expected by the updater plugin endpoints.
    const firstKey = Object.keys(next.platforms)[0];
    platforms[archKey] = next.platforms[firstKey];
  }
  const merged: LatestJson = {
    version: next.version ?? base.version,
    notes: next.notes ?? base.notes,
    pub_date: pickLatest(base.pub_date, next.pub_date),
    platforms,
  };
  return merged as unknown as Record<string, unknown>;
}

function tauriArchKey(triple: string): string | null {
  if (triple === "aarch64-apple-darwin") return "darwin-aarch64";
  if (triple === "x86_64-apple-darwin") return "darwin-x86_64";
  if (triple === "x86_64-pc-windows-msvc") return "windows-x86_64";
  if (triple === "x86_64-unknown-linux-gnu") return "linux-x86_64";
  return null;
}

function pickLatest(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

function packageProject(
  _config: ProjectConfig,
  builderArgs: string[],
  version: string,
  packageInfo: PackageInfo,
  options: { skipSigning: boolean },
) {
  packageDesktop(builderArgs, { ...packageInfo, version }, options);
}

function createGitTag(tagName: string, message: string | null) {
  if (message) {
    runCommand("git", ["tag", "-a", tagName, "-m", message], { cwd: repoRoot });
  } else {
    runCommand("git", ["tag", tagName], { cwd: repoRoot });
  }
}

function pushGitTag(tagName: string) {
  runCommand("git", ["push", "origin", tagName], { cwd: repoRoot });
}

function pushCurrentBranch() {
  runCommand("git", ["push", "origin", "HEAD"], { cwd: repoRoot });
}

function resolveReleaseDir(version: string): string {
  return path.join(desktopProjectDir, "release", version);
}

function collectReleaseArtifacts(
  config: ProjectConfig,
  version: string,
): ReleaseArtifact[] {
  const releaseDir = resolveReleaseDir(version);
  let entries: Dirent[];
  try {
    entries = readdirSync(releaseDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Unable to read release output directory ${relativeToRepo(releaseDir)}: ${(error as Error).message}`,
    );
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(releaseDir, entry.name));
  if (files.length === 0) {
    throw new Error(
      `No release artifacts for version ${version} found in ${relativeToRepo(releaseDir)}. Did packaging succeed?`,
    );
  }
  return files.map((filePath) => ({
    project: config.name,
    path: relativeToRepo(filePath),
  }));
}

function createGithubRelease(
  configs: ProjectConfig[],
  tagName: string,
  version: string,
  title: string,
) {
  const ghRepo = process.env.GH_REPO;
  const artifactSet = new Set<string>();
  const artifacts: ReleaseArtifact[] = [];

  for (const config of configs) {
    for (const artifact of collectReleaseArtifacts(config, version)) {
      if (!artifactSet.has(artifact.path)) {
        artifactSet.add(artifact.path);
        artifacts.push(artifact);
      }
    }
  }

  const args = [
    "release",
    "create",
    tagName,
    "--title",
    title,
    "--generate-notes",
  ];
  if (ghRepo) {
    args.push("--repo", ghRepo);
  }
  runCommand("gh", args, { cwd: repoRoot });

  for (const artifact of artifacts) {
    const uploadArgs = ["release", "upload", tagName, artifact.path, "--clobber"];
    if (ghRepo) {
      uploadArgs.push("--repo", ghRepo);
    }
    runCommand("gh", uploadArgs, { cwd: repoRoot });
  }
}

function uploadToExistingRelease(
  configs: ProjectConfig[],
  tagName: string,
  version: string,
) {
  const ghRepo = process.env.GH_REPO;
  if (!ghRepo) {
    throw new Error("GH_REPO environment variable is required for upload.");
  }

  for (const config of configs) {
    let files: ReleaseArtifact[];
    try {
      files = collectReleaseArtifacts(config, version);
    } catch {
      console.log(`No artifacts found for ${config.name}, skipping.`);
      continue;
    }
    for (const artifact of files) {
      const uploadArgs = [
        "release",
        "upload",
        tagName,
        artifact.path,
        "--clobber",
        "--repo",
        ghRepo,
      ];
      console.log(`Uploading ${artifact.path}…`);
      runCommand("gh", uploadArgs, { cwd: repoRoot });
    }
  }
}

function normaliseTag(versionOrTag: string): string {
  const trimmed = versionOrTag.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function tagRelease(
  configs: ProjectConfig[],
  packageInfos: PackageInfo[],
  requestedVersion: string | null,
  tagOverride: string | null,
) {
  const baseVersion = packageInfos[0].version;
  const targetVersion = requestedVersion
    ? normaliseVersionInput(requestedVersion)
    : incrementPatchVersion(baseVersion);

  assertSemver(targetVersion);
  const releaseNotes = extractChangelogEntry(targetVersion);
  ensureCleanWorkingTree();

  console.log(`Bumping version ${baseVersion} → ${targetVersion}…`);
  configs.forEach((config, index) => {
    updatePackageVersion(config, targetVersion);
    packageInfos[index] = { ...packageInfos[index], version: targetVersion };
  });
  updateTauriConfVersion(targetVersion);
  updateCargoTomlVersion(tauriCargoTomlPath, targetVersion);
  updateCargoTomlVersion(rustServerManifestPath, targetVersion);
  updateNpxCliVersion(targetVersion);

  console.log("Updating Cargo.lock…");
  updateCargoLock();

  console.log("Committing version bump…");
  commitUnifiedVersionBump(targetVersion);
  console.log("Pushing current branch to origin…");
  pushCurrentBranch();

  const tagName = normaliseTag(tagOverride ?? targetVersion);
  console.log(`Creating git tag ${tagName}…`);
  createGitTag(tagName, releaseNotes);
  console.log(`Pushing tag ${tagName} to origin…`);
  pushGitTag(tagName);

  console.log(`Done. CI will create the Desktop release for ${tagName}.`);
}

function main(options: Options) {
  ensureGhRepoConfigured(options.command);
  const projects = options.projects;
  const configs = projects.map(getProjectConfig);
  const packageInfos = configs.map(readPackageInfo);
  const multiProject = configs.length > 1;

  if (
    options.command !== "release" &&
    options.command !== "upload" &&
    options.command !== "tag" &&
    options.version
  ) {
    throw new Error(
      "--version is only supported for the release/upload/tag command.",
    );
  }

  if (options.command === "tag") {
    tagRelease(configs, packageInfos, options.version, options.tag);
    return;
  }

  if (options.command === "upload") {
    const version = packageInfos[0].version;
    const tagName = options.tag ?? `v${version}`;
    console.log(`Uploading artifacts for ${tagName} (version ${version})…`);
    uploadToExistingRelease(configs, tagName, version);
    console.log("Done.");
    return;
  }

  let targetVersion: string | null = null;
  let releaseNotes: string | null = null;
  const configsWithVersionChange: ProjectConfig[] = [];

  if (options.command === "release") {
    const baseVersion = packageInfos[0].version;
    const requestedVersion = options.version
      ? normaliseVersionInput(options.version)
      : incrementPatchVersion(baseVersion);
    assertSemver(requestedVersion);
    releaseNotes = extractChangelogEntry(requestedVersion);
    ensureCleanWorkingTree();

    console.log(`Bumping version ${baseVersion} → ${requestedVersion}…`);
    configs.forEach((config, index) => {
      updatePackageVersion(config, requestedVersion);
      configsWithVersionChange.push(config);
      packageInfos[index] = {
        ...packageInfos[index],
        version: requestedVersion,
      };
    });
    updateTauriConfVersion(requestedVersion);
    updateCargoTomlVersion(tauriCargoTomlPath, requestedVersion);
    updateCargoTomlVersion(rustServerManifestPath, requestedVersion);
    updateNpxCliVersion(requestedVersion);

    console.log("Updating Cargo.lock…");
    updateCargoLock();
    targetVersion = requestedVersion;
  }

  const builderArgs = options.builderArgs;
  configs.forEach((config, index) => {
    const info = packageInfos[index];
    const versionForPackaging =
      options.command === "release" && targetVersion
        ? targetVersion
        : info.version;
    console.log(`Packaging ${info.name} (${versionForPackaging})…`);
    packageProject(config, builderArgs, versionForPackaging, info, {
      skipSigning: options.skipSigning,
    });
  });

  if (options.command === "release" && targetVersion) {
    if (configsWithVersionChange.length > 0) {
      console.log("Committing version bump…");
      commitUnifiedVersionBump(targetVersion);
      console.log("Pushing current branch to origin…");
      pushCurrentBranch();
    }

    const tagName = normaliseTag(options.tag ?? targetVersion);
    console.log(`Creating git tag ${tagName}…`);
    createGitTag(tagName, releaseNotes);
    console.log(`Pushing tag ${tagName} to origin…`);
    pushGitTag(tagName);

    const productNames = packageInfos.map((info) => info.productName);
    const releaseTitleBase = multiProject
      ? productNames.join(" + ")
      : productNames[0];
    const releaseTitle = `${releaseTitleBase} v${targetVersion}`;

    console.log(`Creating GitHub release for ${tagName}…`);
    createGithubRelease(configs, tagName, targetVersion, releaseTitle);
  }

  console.log("Done.");
}

try {
  const options = parseArgs(process.argv.slice(2));
  main(options);
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
