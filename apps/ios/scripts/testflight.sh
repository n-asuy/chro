#!/usr/bin/env bash
# Archive the app and upload it to TestFlight (internal testing) for the Curino LLC team.
# Signing and the upload authenticate with an App Store Connect API key of that team
# (Admin role, so Xcode's automatic signing can create the distribution certificate
# and App Store profile), passed in the environment:
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (path to AuthKey_<id>.p8, kept outside the repo)
# The app record com.chro-ai.ios must already exist in App Store Connect.
# Usage: apps/ios/scripts/testflight.sh [build number]   (default: UTC timestamp)
set -euo pipefail
auth=(-allowProvisioningUpdates
  -authenticationKeyPath "${ASC_KEY_PATH:?set ASC_KEY_PATH}"
  -authenticationKeyID "${ASC_KEY_ID:?set ASC_KEY_ID}"
  -authenticationKeyIssuerID "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}")
ios="$(cd "$(dirname "$0")/.." && pwd)"
build_number="${1:-$(date -u +%Y%m%d%H%M)}"
out="$ios/build/testflight-$build_number"
mkdir -p "$out"
cd "$ios"
xcodegen generate >/dev/null
xcodebuild -project ChroMobile.xcodeproj -scheme ChroMobile -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$out/Chro.xcarchive" \
  "${auth[@]}" CURRENT_PROJECT_VERSION="$build_number" archive
cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>BG439TZ56H</string>
  <key>signingStyle</key><string>automatic</string>
  <key>testFlightInternalTestingOnly</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST
xcodebuild -exportArchive -archivePath "$out/Chro.xcarchive" \
  -exportOptionsPlist "$out/ExportOptions.plist" -exportPath "$out/export" "${auth[@]}"
echo "Uploaded build $build_number"
