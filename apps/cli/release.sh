#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_CARGO="$REPO_ROOT/crates/server/Cargo.toml"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

if [ -z "${R2_ENDPOINT:-}" ] || [ -z "${R2_BUCKET:-}" ] || [ -z "${R2_PUBLIC_URL:-}" ]; then
  echo "Error: R2_ENDPOINT, R2_BUCKET, and R2_PUBLIC_URL are required" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "Error: aws CLI is required for release publishing" >&2
  exit 1
fi

# --- Version bump ---
BUMP_TYPE="${1:-}"
if [ -z "$BUMP_TYPE" ]; then
  echo "Usage: release.sh <patch|minor|major>" >&2
  exit 1
fi

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Error: version type must be patch, minor, or major" >&2
  exit 1
fi

current_repo_version="$(grep '^version' "$SERVER_CARGO" | head -1 | sed 's/.*"\(.*\)".*/\1/')"
latest_npm_version="$(npm view @chro-ai/cli version 2>/dev/null || echo "0.0.0")"

echo "Current repo version: $current_repo_version"
echo "Latest npm version:   $latest_npm_version"

VERSION="$(node -e "
  const npm = '$latest_npm_version'.split('.').map(Number);
  const repo = '$current_repo_version'.split('.').map(Number);
  let base = '$current_repo_version';
  for (let i = 0; i < 3; i++) {
    if ((npm[i] || 0) > (repo[i] || 0)) { base = '$latest_npm_version'; break; }
    if ((npm[i] || 0) < (repo[i] || 0)) { break; }
  }
  const [major, minor, patch] = base.split('.').map(Number);
  const type = '$BUMP_TYPE';
  if (type === 'major') console.log((major+1) + '.0.0');
  else if (type === 'minor') console.log(major + '.' + (minor+1) + '.0');
  else console.log(major + '.' + minor + '.' + (patch+1));
")"

echo "New version:          $VERSION ($BUMP_TYPE bump)"
echo ""

# Update Cargo.toml
sed -i '' 's/^version = ".*"/version = "'"$VERSION"'"/' "$SERVER_CARGO"
echo "Updated $SERVER_CARGO -> $VERSION"

# --- Build ---
echo ""
echo "=== Building release artifacts ==="
bash "$SCRIPT_DIR/local-build.sh"

TGZ_FILE="$(find "$SCRIPT_DIR/npx-cli" -maxdepth 1 -name '*.tgz' -print | head -n 1)"

if [ -z "$TGZ_FILE" ]; then
  echo "Error: npm package tarball not found under apps/cli/npx-cli" >&2
  exit 1
fi

# --- Upload to R2 ---
echo ""
echo "=== Uploading platform binaries to R2 ==="
for platform_zip in "$SCRIPT_DIR"/npx-cli/dist/*/chro-server.zip; do
  if [ -f "$platform_zip" ]; then
    platform_dir="$(basename "$(dirname "$platform_zip")")"
    s3_path="s3://${R2_BUCKET}/releases/v${VERSION}/${platform_dir}/chro-server.zip"
    echo "  Uploading ${platform_dir}/chro-server.zip -> ${s3_path}"
    aws s3 cp "$platform_zip" "$s3_path" --endpoint-url "$R2_ENDPOINT"
  fi
done

echo "Uploading binary manifest..."
aws s3 cp "$SCRIPT_DIR/npx-cli/dist/manifest.json" \
  "s3://${R2_BUCKET}/releases/v${VERSION}/manifest.json" \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type "application/json"

aws s3 cp "$TGZ_FILE" \
  "s3://${R2_BUCKET}/releases/$(basename "$TGZ_FILE")" \
  --endpoint-url "$R2_ENDPOINT"

echo "{\"latest\":\"$VERSION\"}" | aws s3 cp - \
  "s3://${R2_BUCKET}/releases/latest.json" \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type "application/json"

echo ""
echo "R2 URLs:"
for platform_zip in "$SCRIPT_DIR"/npx-cli/dist/*/chro-server.zip; do
  if [ -f "$platform_zip" ]; then
    platform_dir="$(basename "$(dirname "$platform_zip")")"
    echo "  ${R2_PUBLIC_URL}/releases/v${VERSION}/${platform_dir}/chro-server.zip"
  fi
done

# --- Publish to npm ---
echo ""
echo "=== Publishing to npm ==="
PACKED_R2_URL="$(node -e 'const p=require("'"$SCRIPT_DIR"'/npx-cli/package.json"); console.log(p.config?.r2PublicUrl || "")')"
if [ -z "$PACKED_R2_URL" ]; then
  echo "Error: r2PublicUrl is empty in the packed package.json. Set R2_PUBLIC_URL before building." >&2
  exit 1
fi
npm publish "$TGZ_FILE" || {
  echo "(npm publish failed — run manually: npm publish $TGZ_FILE)"
}

# --- Git tag ---
echo ""
echo "=== Creating git tag ==="
TAG="v${VERSION}-$(date +%Y%m%d%H%M%S)"
(
  cd "$REPO_ROOT"
  git add crates/server/Cargo.toml apps/cli/npx-cli/package.json
  git commit -m "chore(cli): bump version to $VERSION"
  git tag -a "$TAG" -m "CLI Release $TAG"
  echo "Tagged: $TAG"
  echo "Run 'git push && git push --tags' to publish"
)

echo ""
echo "=== Release complete ==="
echo "  $TAG"
echo "  npm install -g @chro-ai/cli@$VERSION"
