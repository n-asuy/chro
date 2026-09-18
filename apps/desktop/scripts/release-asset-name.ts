// Naming contract for GitHub release assets.
//
// Installer names carry no version so that
// https://github.com/<owner>/<repo>/releases/latest/download/<name> is a
// permanent link: the website's download buttons point at these names
// directly (apps/lp/src/consts.ts) and must be updated together with this file.

export function releaseAssetName(
  bundleFileName: string,
  version: string,
  triple: string,
): string {
  const unversioned = bundleFileName.replace(`_${version}`, "");
  // Tauri names the macOS updater bundle "<Product>.app.tar.gz" with no arch,
  // so the arm64 and x64 runners would clobber each other on the shared
  // release. Give each arch a distinct name so both survive and the updater
  // manifest can reference them by URL.
  const macUpdater = unversioned.match(/^(.*)\.app\.tar\.gz(\.sig)?$/i);
  if (macUpdater && triple.includes("apple-darwin")) {
    return `${macUpdater[1]}_${macArchSuffix(triple)}.app.tar.gz${macUpdater[2] ?? ""}`;
  }
  return unversioned;
}

export function macArchSuffix(triple: string): string {
  if (triple === "aarch64-apple-darwin") {
    return "aarch64";
  }
  if (triple === "x86_64-apple-darwin") {
    return "x64";
  }
  return triple;
}
