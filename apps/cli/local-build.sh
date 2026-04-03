#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_CARGO="$REPO_ROOT/crates/server/Cargo.toml"

resolve_platform_dir() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin)
      case "$arch" in
        arm64) echo "macos-arm64 chro-server" ;;
        x86_64) echo "macos-x64 chro-server" ;;
        *) echo "Unsupported macOS arch: $arch" >&2; exit 1 ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) echo "linux-x64 chro-server" ;;
        aarch64|arm64) echo "linux-arm64 chro-server" ;;
        *) echo "Unsupported Linux arch: $arch" >&2; exit 1 ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      case "$arch" in
        x86_64|AMD64) echo "windows-x64 chro-server.exe" ;;
        aarch64|ARM64) echo "windows-arm64 chro-server.exe" ;;
        *) echo "Unsupported Windows arch: $arch" >&2; exit 1 ;;
      esac
      ;;
    *)
      echo "Unsupported OS: $os" >&2
      exit 1
      ;;
  esac
}

VERSION="$(grep '^version' "$SERVER_CARGO" | head -1 | sed 's/.*"\(.*\)".*/\1/')"
read -r PLATFORM_DIR BIN_NAME <<<"$(resolve_platform_dir)"
R2_PUBLIC_URL_VALUE="${R2_PUBLIC_URL:-}"

echo "=== Chro CLI Build ==="
echo "Version:  $VERSION"
echo "Platform: $PLATFORM_DIR"

echo "Cleaning previous builds..."
rm -rf "$SCRIPT_DIR/npx-cli/dist"
mkdir -p "$SCRIPT_DIR/npx-cli/dist/$PLATFORM_DIR"

echo "Building frontend..."
(cd "$REPO_ROOT" && bun run --filter=@chro/desktop build)

echo "Building chro-server (release)..."
cargo build --release --manifest-path "$SERVER_CARGO"

echo "Creating distribution package..."
TARGET_DIR="$REPO_ROOT/crates/server/target/release"
if [ ! -f "$TARGET_DIR/$BIN_NAME" ]; then
  TARGET_DIR="$REPO_ROOT/target/release"
fi
cp "$TARGET_DIR/$BIN_NAME" "$SCRIPT_DIR/$BIN_NAME"
(cd "$SCRIPT_DIR" && zip -q chro-server.zip "$BIN_NAME")
rm -f "$SCRIPT_DIR/$BIN_NAME"
mv "$SCRIPT_DIR/chro-server.zip" "$SCRIPT_DIR/npx-cli/dist/$PLATFORM_DIR/chro-server.zip"

echo "Generating binary manifest..."
node -e '
const fs = require("fs");
const crypto = require("crypto");
const manifest = { version: "v" + process.argv[1], platforms: {} };
const distDir = process.argv[2] + "/npx-cli/dist";

for (const platform of fs.readdirSync(distDir)) {
  const platformPath = distDir + "/" + platform;
  if (!fs.statSync(platformPath).isDirectory()) continue;
  manifest.platforms[platform] = {};
  const zipPath = platformPath + "/chro-server.zip";
  if (fs.existsSync(zipPath)) {
    const data = fs.readFileSync(zipPath);
    manifest.platforms[platform]["chro-server"] = {
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      size: data.length
    };
  }
}
fs.writeFileSync(distDir + "/manifest.json", JSON.stringify(manifest, null, 2));
console.log("  " + distDir + "/manifest.json");
' "$VERSION" "$SCRIPT_DIR"

echo "Syncing npm package metadata..."
node -e '
const fs = require("fs");
const path = "'"$SCRIPT_DIR"'/npx-cli/package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.version = process.argv[1];
pkg.config = { ...(pkg.config || {}), r2PublicUrl: process.argv[2] || "" };
fs.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
' "$VERSION" "$R2_PUBLIC_URL_VALUE"

echo "Packing npm package..."
pushd "$SCRIPT_DIR/npx-cli" >/dev/null
rm -f ./*.tgz
TGZ_FILE="$(npm pack --quiet | tail -n 1)"
popd >/dev/null

echo ""
echo "=== Build complete ==="
echo "  apps/cli/npx-cli/$TGZ_FILE"
if [ -n "$R2_PUBLIC_URL_VALUE" ]; then
  echo "  R2 public base: $R2_PUBLIC_URL_VALUE"
else
  echo "  R2 public base: not configured"
fi
echo ""
echo "Install locally:"
echo "  npm install -g ./apps/cli/npx-cli/$TGZ_FILE"
