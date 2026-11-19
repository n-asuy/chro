#!/usr/bin/env bash
# Bundles the repo's CHANGELOG.md and the chro release version (apps/desktop/package.json)
# into the app, the way the desktop bakes them into its build: the release notes screen and
# the version chip read them from the bundle, so they can never drift from what was built.
#
#   apps/ios/scripts/bundle-changelog.sh
#
# Runs before every app build (project.yml preBuildScripts); a file is rewritten only when its
# content changed, so an unchanged checkout neither dirties the tree nor re-copies the bundle.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$here/../ChroMobile/Resources/Release"
mkdir -p "$out"
cmp -s "$repo/CHANGELOG.md" "$out/CHANGELOG.md" || cp "$repo/CHANGELOG.md" "$out/CHANGELOG.md"
version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$repo/apps/desktop/package.json" | head -1)"
[ -n "$version" ] || { echo "no version in apps/desktop/package.json" >&2; exit 1; }
release="$(printf '{"version":"%s"}' "$version")"
[ "$(cat "$out/chro-release.json" 2>/dev/null)" = "$release" ] || printf '%s\n' "$release" > "$out/chro-release.json"
