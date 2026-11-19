#!/usr/bin/env bash
# Copies the desktop's brand assets into the iOS app so both ship the same files:
#   - InterVariable (apps/desktop/src/app/fonts), converted from WOFF2 to TTF,
#     which iOS registers at launch (fontTools with brotli: pip install fonttools brotli)
#   - the chro symbol (a one-colour mark, drawn as a template in the text colour so it
#     reads in light and dark), the bundled Claude mark with its white backing keyed
#     out (the desktop file is opaque, a white tile on dark surfaces) and the Codex mark
#     (Pillow: pip install pillow)
#   - the app icon from the desktop's iOS icon set
#
#   apps/ios/scripts/import-desktop-assets.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ios="$here/.."
desktop="$ios/../desktop"
catalog="$ios/ChroMobile/Resources/Assets.xcassets"
fonts="$ios/ChroMobile/Resources/Fonts"

mkdir -p "$fonts"
python3 -c '
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
font.flavor = None
font.save(sys.argv[2])
' "$desktop/src/app/fonts/InterVariable.woff2" "$fonts/InterVariable.ttf"

imageset() { # name, source file, template(true|false)
  local name="$1" src="$2" template="$3" ext="${2##*.}" dir="$catalog/Brand/$1.imageset"
  rm -rf "$dir" && mkdir -p "$dir"
  cp "$src" "$dir/$name.$ext"
  local intent='"template-rendering-intent" : "original"'
  if [ "$template" = true ]; then
    intent='"template-rendering-intent" : "template"'
    [ "$ext" = svg ] && intent='"preserves-vector-representation" : true, '"$intent"
  fi
  cat > "$dir/Contents.json" <<JSON
{
  "images" : [ { "filename" : "$name.$ext", "idiom" : "universal" } ],
  "info" : { "author" : "xcode", "version" : 1 },
  "properties" : { $intent }
}
JSON
}

mkdir -p "$catalog/Brand"
cat > "$catalog/Brand/Contents.json" <<'JSON'
{
  "info" : { "author" : "xcode", "version" : 1 },
  "properties" : { "provides-namespace" : true }
}
JSON
cat > "$catalog/Contents.json" <<'JSON'
{
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

imageset chro-symbol "$desktop/public/logo_chro_symbol.png" true

# The Claude mark is one orange on white: alpha is how far each pixel sits from
# white toward the mark's colour (anti-aliased edges keep their coverage).
tmp_claude="$(mktemp -d)/agent-claude.png"
python3 -c '
import sys
from collections import Counter
from PIL import Image
image = Image.open(sys.argv[1]).convert("RGB")
ink = Counter(p for p in image.getdata() if p != (255, 255, 255)).most_common(1)[0][0]
def coverage(pixel):
    spans = [255 - c for c in ink]
    return max(0.0, min(1.0, max((255 - v) / s for v, s in zip(pixel, spans) if s > 0)))
out = Image.new("RGBA", image.size)
out.putdata([ink + (round(255 * coverage(p)),) for p in image.getdata()])
out.save(sys.argv[2])
' "$desktop/public/icon_claude.png" "$tmp_claude"
imageset agent-claude "$tmp_claude" false

# components/agent-logo.tsx draws the Codex mark inline; the same path as a template vector.
codex_path="$(sed -n 's/.*const OPENAI_PATH *= *"\([^"]*\)".*/\1/p' "$desktop/src/components/agent-logo.tsx")"
if [ -z "$codex_path" ]; then
  codex_path="$(grep -o 'd="M22.282[^"]*"' "$desktop/src/components/agent-logo.tsx" | head -1 | sed 's/^d="//; s/"$//')"
fi
[ -n "$codex_path" ] || { echo "Codex mark not found in agent-logo.tsx" >&2; exit 1; }
tmp_svg="$(mktemp -d)/agent-codex.svg"
printf '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#000000" d="%s"/></svg>\n' "$codex_path" > "$tmp_svg"
imageset agent-codex "$tmp_svg" true

# components/folder-icon.tsx: the solid folder of the project overview header.
folder_path="$(grep -o 'd="M19.5 21a3[^"]*"' "$desktop/src/components/folder-icon.tsx" | head -1 | sed 's/^d="//; s/"$//')"
[ -n "$folder_path" ] || { echo "folder glyph not found in folder-icon.tsx" >&2; exit 1; }
tmp_folder="$(mktemp -d)/folder-solid.svg"
printf '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#000000" d="%s"/></svg>\n' "$folder_path" > "$tmp_folder"
imageset folder-solid "$tmp_folder" true

icon_dir="$catalog/AppIcon.appiconset"
rm -rf "$icon_dir" && mkdir -p "$icon_dir"
# App Store Connect rejects a large app icon with an alpha channel. The desktop's
# iOS icon is opaque but stored as RGBA, so composite it onto white and save RGB.
python3 -c '
import sys
from PIL import Image
icon = Image.open(sys.argv[1]).convert("RGBA")
flat = Image.new("RGB", icon.size, (255, 255, 255))
flat.paste(icon, mask=icon.getchannel("A"))
flat.save(sys.argv[2])
' "$desktop/src-tauri/icons/ios/AppIcon-512@2x.png" "$icon_dir/AppIcon-1024.png"
cat > "$icon_dir/Contents.json" <<'JSON'
{
  "images" : [ { "filename" : "AppIcon-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" } ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
echo "imported fonts and brand assets into $ios/ChroMobile/Resources"
