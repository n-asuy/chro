#!/bin/bash
set -euo pipefail

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
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

echo "=== Building release artifacts ==="
bash ./local-build.sh

VERSION="$(grep '^version' ../../crates/server/Cargo.toml | head -1 | sed 's/.*"\(.*\)".*/\1/')"
TGZ_FILE="$(find npx-cli -maxdepth 1 -name '*.tgz' -print | head -n 1)"

if [ -z "$TGZ_FILE" ]; then
  echo "Error: npm package tarball not found under apps/cli/npx-cli" >&2
  exit 1
fi

echo ""
echo "=== Uploading platform binaries to R2 ==="
for platform_zip in npx-cli/dist/*/chro-server.zip; do
  if [ -f "$platform_zip" ]; then
    platform_dir="$(basename "$(dirname "$platform_zip")")"
    s3_path="s3://${R2_BUCKET}/releases/v${VERSION}/${platform_dir}/chro-server.zip"
    echo "  Uploading ${platform_dir}/chro-server.zip -> ${s3_path}"
    aws s3 cp "$platform_zip" "$s3_path" --endpoint-url "$R2_ENDPOINT"
  fi
done

aws s3 cp "$TGZ_FILE" \
  "s3://${R2_BUCKET}/releases/$(basename "$TGZ_FILE")" \
  --endpoint-url "$R2_ENDPOINT"

echo "{\"latest\":\"$VERSION\"}" | aws s3 cp - \
  "s3://${R2_BUCKET}/releases/latest.json" \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type "application/json"

echo ""
echo "R2 URLs:"
for platform_zip in npx-cli/dist/*/chro-server.zip; do
  if [ -f "$platform_zip" ]; then
    platform_dir="$(basename "$(dirname "$platform_zip")")"
    echo "  ${R2_PUBLIC_URL}/releases/v${VERSION}/${platform_dir}/chro-server.zip"
  fi
done

echo ""
echo "=== Publishing to npm ==="
PACKED_R2_URL="$(node -e 'const p=require("./npx-cli/package.json"); console.log(p.config?.r2PublicUrl || "")')"
if [ -z "$PACKED_R2_URL" ]; then
  echo "Error: r2PublicUrl is empty in the packed package.json. Set R2_PUBLIC_URL before building." >&2
  exit 1
fi
npm publish "./$TGZ_FILE" || {
  echo "(npm publish failed — run manually: npm publish ./$TGZ_FILE)"
}

echo ""
echo "=== Release complete ==="
echo "  npm install -g @chro-ai/cli"
