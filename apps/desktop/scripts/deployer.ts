#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..", "..");

const rustServerCrateDir = path.join(repoRoot, "crates", "server");
const rustServerReleaseDir = path.join(rustServerCrateDir, "target", "release");
const rustServerBinaryBaseName = "chro-server";
const rustServerManifestPath = path.join(rustServerCrateDir, "Cargo.toml");

type RustBuildContext = {
  label: string;
  triple?: string;
  binaryName: string;
};

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

function tagRelease(
  configs: ProjectConfig[],
  packageInfos: PackageInfo[],
  requestedVersion: string | null,
  tagOverride: string | null,
  releaseMessage: string | null,
) {
  const baseVersion = packageInfos[0].version;
  const targetVersion = requestedVersion
    ? normaliseVersionInput(requestedVersion)
    : incrementPatchVersion(baseVersion);

  assertSemver(targetVersion);
  ensureCleanWorkingTree();

  const configsWithVersionChange: ProjectConfig[] = [];

  configs.forEach((config, index) => {
    const currentVersion = packageInfos[index].version;
    if (currentVersion !== targetVersion) {
      console.log(
        `Updating package version ${currentVersion} → ${targetVersion} for ${config.name}…`,
      );
      updatePackageVersion(config, targetVersion);
      configsWithVersionChange.push(config);
      packageInfos[index] = {
        ...packageInfos[index],
        version: targetVersion,
      };
    }
  });

  if (configsWithVersionChange.length > 0) {
    console.log("Committing package version bump…");
    commitVersionBump(configsWithVersionChange, targetVersion);
    console.log("Pushing current branch to origin…");
    pushCurrentBranch();
  }

  const tagName = normaliseTag(tagOverride ?? targetVersion);
  console.log(`Creating git tag ${tagName}…`);
  createGitTag(tagName, releaseMessage);
  console.log(`Pushing tag ${tagName} to origin…`);
  pushGitTag(tagName);

  console.log(`Done. CI will create the release for ${tagName}.`);
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
  let productName = config.fallbackProductName;

  const build = pkg.build;
  if (build && typeof build === "object") {
    const candidate = (build as Record<string, unknown>).productName;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      productName = candidate;
    }
  }

  return { name, version, productName };
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
  const nextPatch = Number(patch) + 1;
  return `${major}.${minor}.${nextPatch}`;
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

  const stdout = capture && result.stdout ? result.stdout.toString() : "";
  return { stdout };
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

interface PackagingOptions {
  skipSigning: boolean;
}

function ensureRustTarget(target: string) {
  if (ensuredRustTargets.has(target)) {
    return;
  }
  runCommand("rustup", ["target", "add", target], { cwd: repoRoot });
  ensuredRustTargets.add(target);
}

function detectRustBuildContext(runArgs: string[]): RustBuildContext | null {
  if (runArgs.includes("--mac")) {
    if (runArgs.includes("--arm64")) {
      return {
        label: "macOS arm64",
        triple: "aarch64-apple-darwin",
        binaryName: rustServerBinaryBaseName,
      };
    }
    if (runArgs.includes("--x64")) {
      return {
        label: "macOS x64",
        triple: "x86_64-apple-darwin",
        binaryName: rustServerBinaryBaseName,
      };
    }
    return {
      label: "macOS",
      binaryName: rustServerBinaryBaseName,
    };
  }

  if (runArgs.includes("--win")) {
    if (process.platform !== "win32") {
      throw new Error(
        "Windows builds require a Windows environment. Use GitHub Actions or a Windows machine.",
      );
    }
    return {
      label: "Windows x64",
      binaryName: `${rustServerBinaryBaseName}.exe`,
    };
  }

  if (runArgs.includes("--linux")) {
    return {
      label: "Linux x64",
      triple:
        process.platform === "linux" ? undefined : "x86_64-unknown-linux-gnu",
      binaryName: rustServerBinaryBaseName,
    };
  }

  return null;
}

function stageRustBinary(context: RustBuildContext) {
  const sourceDir = context.triple
    ? path.join(rustServerCrateDir, "target", context.triple, "release")
    : rustServerReleaseDir;
  const sourcePath = path.join(sourceDir, context.binaryName);
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Expected Rust binary at ${relativeToRepo(sourcePath)}, but it was not found. Ensure cargo build completed successfully.`,
    );
  }

  mkdirSync(rustServerReleaseDir, { recursive: true });
  const destinationPath = path.join(rustServerReleaseDir, context.binaryName);

  // Skip copy if source and destination are the same (native build without cross-compilation)
  if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
    console.log(
      `Rust binary already at ${relativeToRepo(destinationPath)}, skipping copy.`,
    );
    return;
  }

  if (existsSync(destinationPath)) {
    rmSync(destinationPath, { force: true });
  }
  copyFileSync(sourcePath, destinationPath);
}

function buildRustBinaryForContext(context: RustBuildContext) {
  const cargoArgs = [
    "build",
    "--release",
    "--manifest-path",
    rustServerManifestPath,
    "--bin",
    rustServerBinaryBaseName,
  ];
  if (context.triple) {
    ensureRustTarget(context.triple);
    cargoArgs.push("--target", context.triple);
  }

  console.log(`Building Rust server (${context.label})…`);
  runCommand("cargo", cargoArgs, { cwd: repoRoot });
  stageRustBinary(context);
}

function packageDesktop(
  projectDir: string,
  builderArgs: string[],
  version: string,
  options: PackagingOptions,
) {
  runCommand("bun", ["run", "build"], { cwd: projectDir });

  const defaultRuns: string[][] =
    process.platform === "darwin"
      ? [
          ["--mac", "--arm64"],
          ["--mac", "--x64"],
        ]
      : process.platform === "win32"
        ? [["--win", "--x64"]]
        : [["--linux", "--x64"]];

  // Expand --mac without architecture to both arm64 and x64
  const expandMacArgs = (args: string[]): string[][] => {
    const hasMac = args.includes("--mac");
    const hasArch = args.includes("--arm64") || args.includes("--x64");
    if (hasMac && !hasArch && process.platform === "darwin") {
      const otherArgs = args.filter((arg) => arg !== "--mac");
      return [
        ["--mac", "--arm64", ...otherArgs],
        ["--mac", "--x64", ...otherArgs],
      ];
    }
    return [args];
  };

  const builderRuns =
    builderArgs.length > 0 ? expandMacArgs(builderArgs) : defaultRuns;

  const builderEnv: NodeJS.ProcessEnv | undefined = options.skipSigning
    ? {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        CSC_LINK: undefined,
        CSC_KEY_PASSWORD: undefined,
        CSC_NAME: undefined,
        APPLE_ID: undefined,
        APPLE_APP_SPECIFIC_PASSWORD: undefined,
        APPLE_ID_PASSWORD: undefined,
        APPLE_TEAM_ID: undefined,
        APPLE_API_KEY: undefined,
        APPLE_API_KEY_ID: undefined,
        APPLE_API_ISSUER: undefined,
      }
    : undefined;

  const distDir = path.join(projectDir, "dist");
  const stashRoot =
    builderRuns.length > 1
      ? path.join(projectDir, ".deployer-staged-artifacts")
      : null;
  const stashedDirs: string[] = [];

  if (stashRoot) {
    if (existsSync(stashRoot)) {
      rmSync(stashRoot, { recursive: true, force: true });
    }
    mkdirSync(stashRoot, { recursive: true });
  }

  try {
    builderRuns.forEach((runArgs, index) => {
      const rustContext = detectRustBuildContext(runArgs);
      if (rustContext) {
        buildRustBinaryForContext(rustContext);
      }
      runCommand(
        "bun",
        ["x", "electron-builder", ...runArgs, "--publish", "never"],
        {
          cwd: projectDir,
          env: builderEnv,
        },
      );

      if (!stashRoot || index === builderRuns.length - 1) {
        return;
      }

      const runStashDir = path.join(stashRoot, `run-${index}`);
      stashBuilderOutput(distDir, runStashDir);
      stashedDirs.push(runStashDir);
    });
  } finally {
    if (stashRoot) {
      restoreStashedOutputs(distDir, stashedDirs);
      rmSync(stashRoot, { recursive: true, force: true });
    }
  }

  moveArtifactsToRelease(projectDir, version);
}

function packageDesktopEditor(
  projectDir: string,
  builderArgs: string[],
  version: string,
  _options: PackagingOptions,
) {
  runCommand("bun", ["run", "sync-version"], {
    cwd: projectDir,
    env: { APP_VERSION: version },
  });
  runCommand("bun", ["run", "prepack-app"], { cwd: projectDir });
  const effectiveArgs = builderArgs.length > 0 ? builderArgs : ["--mac"];
  runCommand("bun", ["x", "electron-builder", ...effectiveArgs], {
    cwd: projectDir,
  });
}

function stashBuilderOutput(sourceDir: string, targetDir: string) {
  if (!existsSync(sourceDir)) {
    return;
  }
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (entries.length === 0) {
    return;
  }
  mkdirSync(targetDir, { recursive: true });
  entries.forEach((entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    renameSync(sourcePath, targetPath);
  });
}

function restoreStashedOutputs(distDir: string, stashedDirs: string[]) {
  if (!stashedDirs.length) {
    return;
  }
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }
  stashedDirs.forEach((stashDir) => {
    if (!existsSync(stashDir)) {
      return;
    }
    const entries = readdirSync(stashDir, { withFileTypes: true });
    entries.forEach((entry) => {
      const sourcePath = path.join(stashDir, entry.name);
      const targetPath = path.join(distDir, entry.name);
      if (existsSync(targetPath)) {
        if (entry.name === "latest-mac.yml") {
          mergeLatestMacYmlFromFilePaths(targetPath, sourcePath);
          rmSync(sourcePath, { recursive: true, force: true });
          return;
        }
        console.warn(
          `Skipping restoration of ${entry.name} because ${relativeToRepo(targetPath)} already exists.`,
        );
        return;
      }
      renameSync(sourcePath, targetPath);
    });
    rmSync(stashDir, { recursive: true, force: true });
  });
}

function moveArtifactsToRelease(projectDir: string, version: string) {
  const distDir = path.join(projectDir, "dist");
  if (!existsSync(distDir)) {
    console.warn(`No dist directory found at ${relativeToRepo(distDir)}.`);
    return;
  }
  const entries = readdirSync(distDir, { withFileTypes: true });
  if (entries.length === 0) {
    console.warn(`No artifacts produced in ${relativeToRepo(distDir)}.`);
    return;
  }

  const releaseDir = path.join(projectDir, "release", version);
  if (existsSync(releaseDir)) {
    rmSync(releaseDir, { recursive: true, force: true });
  }
  mkdirSync(releaseDir, { recursive: true });

  entries.forEach((entry) => {
    const sourcePath = path.join(distDir, entry.name);
    const targetPath = path.join(releaseDir, entry.name);
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    renameSync(sourcePath, targetPath);
  });

  rmSync(distDir, { recursive: true, force: true });
}

function packageProject(
  config: ProjectConfig,
  builderArgs: string[],
  version: string,
  options: PackagingOptions,
) {
  switch (config.name) {
    case "desktop":
      packageDesktop(config.projectDir, builderArgs, version, options);
      return;
    default: {
      const neverProject: never = config.name;
      throw new Error(`Unsupported project: ${neverProject}`);
    }
  }
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

function commitVersionBump(configs: ProjectConfig[], newVersion: string) {
  if (configs.length === 0) {
    return;
  }

  const paths = configs.map((config) => config.packageJsonRelativePath);
  runCommand("git", ["add", ...paths], { cwd: repoRoot });

  const scopes = configs.map((config) => config.commitScope).join(" ");
  runCommand("git", ["commit", "-m", `release ${scopes} ${newVersion}`], {
    cwd: repoRoot,
  });
}

function pushCurrentBranch() {
  runCommand("git", ["push", "origin", "HEAD"], { cwd: repoRoot });
}

function resolveReleaseDir(config: ProjectConfig, version: string): string {
  switch (config.name) {
    case "desktop":
      return path.join(config.projectDir, "release", version);
    default: {
      const neverProject: never = config.name;
      throw new Error(`Unsupported project: ${neverProject}`);
    }
  }
}

function collectReleaseArtifacts(
  config: ProjectConfig,
  version: string,
): ReleaseArtifact[] {
  const releaseDir = resolveReleaseDir(config, version);
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

  const filesForRelease = files.filter((filePath) => {
    const basename = path.basename(filePath);
    const isReleaseMetadata =
      basename === "latest-mac.yml" || basename === "latest.yml";
    const isWindowsInstaller =
      basename === `Chro Setup ${version}.exe` ||
      basename === `Chro.Setup.${version}.exe`;
    const isVersionedArtifact =
      basename.startsWith(`Chro-${version}`) &&
      (basename.endsWith(".dmg") ||
        basename.endsWith(".dmg.blockmap") ||
        basename.endsWith(".zip") ||
        basename.endsWith(".zip.blockmap"));
    return isReleaseMetadata || isWindowsInstaller || isVersionedArtifact;
  });

  if (filesForRelease.length === 0) {
    throw new Error(
      `No release artifacts for version ${version} found in ${relativeToRepo(releaseDir)}. Did packaging succeed?`,
    );
  }

  return filesForRelease.map((filePath) => ({
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
    const files = collectReleaseArtifacts(config, version);
    for (const artifact of files) {
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

  if (artifacts.length === 0) {
    return;
  }

  const basenameCounts = new Map<string, number>();
  for (const artifact of artifacts) {
    const baseName = path.basename(artifact.path);
    basenameCounts.set(baseName, (basenameCounts.get(baseName) ?? 0) + 1);
  }

  for (const artifact of artifacts) {
    const baseName = path.basename(artifact.path);
    const needsPrefix = (basenameCounts.get(baseName) ?? 0) > 1;
    const uploadName = needsPrefix
      ? `${artifact.project}-${baseName}`
      : baseName;

    let uploadPath = artifact.path;
    let tempPath: string | null = null;

    // gh release upload does not support --name, so copy to temp file if rename needed
    if (uploadName !== baseName) {
      tempPath = path.join(path.dirname(artifact.path), uploadName);
      copyFileSync(artifact.path, tempPath);
      uploadPath = tempPath;
    }

    const uploadArgs = ["release", "upload", tagName, uploadPath, "--clobber"];
    if (ghRepo) {
      uploadArgs.push("--repo", ghRepo);
    }

    try {
      runCommand("gh", uploadArgs, { cwd: repoRoot });
    } finally {
      if (tempPath) {
        unlinkSync(tempPath);
      }
    }
  }
}

function normaliseTag(versionOrTag: string): string {
  const trimmed = versionOrTag.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

interface LatestYmlFile {
  url: string;
  sha512: string;
  size: number;
}

interface LatestYml {
  version: string;
  files: LatestYmlFile[];
  path?: string;
  sha512?: string;
  releaseDate: string;
}

function mergeLatestMacYmlData(base: LatestYml, incoming: LatestYml): LatestYml {
  const merged: LatestYml = {
    ...base,
    files: [...base.files],
  };

  const existingUrls = new Set(merged.files.map((file) => file.url));
  for (const nextFile of incoming.files) {
    if (!existingUrls.has(nextFile.url)) {
      merged.files.push(nextFile);
      existingUrls.add(nextFile.url);
    }
  }

  merged.files.sort((a, b) => {
    const aIsArm = a.url.includes("arm64");
    const bIsArm = b.url.includes("arm64");
    if (aIsArm && !bIsArm) return -1;
    if (!aIsArm && bIsArm) return 1;
    return a.url.localeCompare(b.url);
  });

  if (new Date(incoming.releaseDate) > new Date(merged.releaseDate)) {
    merged.releaseDate = incoming.releaseDate;
  }

  return merged;
}

function mergeLatestMacYmlFromFilePaths(
  targetPath: string,
  incomingPath: string,
): void {
  const target = parseYaml(readFileSync(targetPath, "utf8")) as LatestYml;
  const incoming = parseYaml(readFileSync(incomingPath, "utf8")) as LatestYml;
  const merged = mergeLatestMacYmlData(target, incoming);
  writeFileSync(targetPath, stringifyYaml(merged), "utf8");
  console.log(`Merged latest-mac.yml with ${merged.files.length} files.`);
}

function downloadReleaseAsset(
  ghRepo: string,
  tagName: string,
  assetName: string,
): string | null {
  const result = spawnSync(
    "gh",
    [
      "release",
      "download",
      tagName,
      "--repo",
      ghRepo,
      "--pattern",
      assetName,
      "--output",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );

  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  return result.stdout;
}

function mergeLatestMacYml(
  localPath: string,
  ghRepo: string,
  tagName: string,
): void {
  const localContent = readFileSync(localPath, "utf8");
  const localYml = parseYaml(localContent) as LatestYml;

  const remoteContent = downloadReleaseAsset(ghRepo, tagName, "latest-mac.yml");
  if (!remoteContent) {
    console.log(
      "No existing latest-mac.yml found in release, using local version.",
    );
    return;
  }

  const remoteYml = parseYaml(remoteContent) as LatestYml;
  const merged = mergeLatestMacYmlData(localYml, remoteYml);
  const mergedContent = stringifyYaml(merged);
  writeFileSync(localPath, mergedContent, "utf8");
  console.log(`Merged latest-mac.yml with ${merged.files.length} files.`);
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

  const artifactSet = new Set<string>();
  const artifacts: ReleaseArtifact[] = [];

  for (const config of configs) {
    let files: ReleaseArtifact[];
    try {
      files = collectReleaseArtifacts(config, version);
    } catch {
      console.log(`No artifacts found for ${config.name}, skipping.`);
      continue;
    }
    for (const artifact of files) {
      if (!artifactSet.has(artifact.path)) {
        artifactSet.add(artifact.path);
        artifacts.push(artifact);
      }
    }
  }

  if (artifacts.length === 0) {
    console.log("No artifacts to upload.");
    return;
  }

  // Merge latest-mac.yml with existing release if present
  const latestMacYmlArtifact = artifacts.find(
    (a) => path.basename(a.path) === "latest-mac.yml",
  );
  if (latestMacYmlArtifact) {
    const absolutePath = path.isAbsolute(latestMacYmlArtifact.path)
      ? latestMacYmlArtifact.path
      : path.join(repoRoot, latestMacYmlArtifact.path);
    mergeLatestMacYml(absolutePath, ghRepo, tagName);
  }

  for (const artifact of artifacts) {
    const uploadArgs = [
      "release",
      "upload",
      tagName,
      artifact.path,
      "--clobber",
    ];
    uploadArgs.push("--repo", ghRepo);

    console.log(`Uploading ${artifact.path}…`);
    runCommand("gh", uploadArgs, { cwd: repoRoot });
  }
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

  // Handle tag command (local mode: bump version, commit, tag, push - CI handles release)
  if (options.command === "tag") {
    tagRelease(configs, packageInfos, options.version, options.tag, options.message);
    return;
  }

  // Handle upload command (CI mode: upload artifacts to existing release)
  if (options.command === "upload") {
    const version = packageInfos[0].version;
    const tagName = options.tag ?? `desktop-v${version}`;
    console.log(`Uploading artifacts for ${tagName} (version ${version})…`);
    uploadToExistingRelease(configs, tagName, version);
    console.log("Done.");
    return;
  }

  let targetVersion: string | null = null;
  const configsWithVersionChange: ProjectConfig[] = [];

  if (options.command === "release") {
    const requestedVersion = options.version
      ? normaliseVersionInput(options.version)
      : (() => {
          const baseVersion = packageInfos[0].version;
          const hasMismatch = packageInfos.some(
            (info) => info.version !== baseVersion,
          );
          if (hasMismatch) {
            throw new Error(
              "Projects have mismatched versions. Use --version to specify the desired release version for all projects.",
            );
          }
          return incrementPatchVersion(baseVersion);
        })();

    assertSemver(requestedVersion);
    ensureCleanWorkingTree();

    configs.forEach((config, index) => {
      const currentVersion = packageInfos[index].version;
      if (currentVersion !== requestedVersion) {
        console.log(
          `Updating package version ${currentVersion} → ${requestedVersion} for ${config.name}…`,
        );
        updatePackageVersion(config, requestedVersion);
        configsWithVersionChange.push(config);
        packageInfos[index] = {
          ...packageInfos[index],
          version: requestedVersion,
        };
      }
    });

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
    packageProject(config, builderArgs, versionForPackaging, {
      skipSigning: options.skipSigning,
    });
  });

  if (options.command === "release" && targetVersion) {
    if (configsWithVersionChange.length > 0) {
      console.log("Committing package version bump…");
      commitVersionBump(configsWithVersionChange, targetVersion);
      console.log("Pushing current branch to origin…");
      pushCurrentBranch();
    }

    const tagName = normaliseTag(options.tag ?? targetVersion);
    console.log(`Creating git tag ${tagName}…`);
    createGitTag(tagName, null);
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
