#!/usr/bin/env bash
# Sign final nested executable bytes, notarize and staple before updater signing.
set -euo pipefail
app="${1:?app bundle path required}"
output="${2:?candidate output directory required}"
: "${MACOS_SIGNING_IDENTITY:?}"
: "${APPLE_TEAM_ID:?}"
: "${APPLE_API_KEY_PATH:?}"
: "${ASC_API_KEY_ID:?}"
: "${ASC_API_ISSUER_ID:?}"
: "${TAURI_SIGNING_PRIVATE_KEY:?}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/aar-sign.XXXXXX")"
trap 'rm -rf "$work"' EXIT
bash desktop/scripts/codesign-with-retry.sh --force --timestamp --options runtime --sign "$MACOS_SIGNING_IDENTITY" --entitlements desktop/scripts/node-entitlements.plist "$app/Contents/Resources/resources/node"
bash desktop/scripts/codesign-with-retry.sh --force --timestamp --options runtime --sign "$MACOS_SIGNING_IDENTITY" "$app"
codesign --verify --deep --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \"$APPLE_TEAM_ID\" and identifier \"com.graehlarts.agent-auth-router\"" "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$work/notarize.zip"
xcrun notarytool submit "$work/notarize.zip" --key "$APPLE_API_KEY_PATH" --key-id "$ASC_API_KEY_ID" --issuer "$ASC_API_ISSUER_ID" --wait --timeout 20m --output-format json > "$output/app-notarization.json"
python3 - "$output/app-notarization.json" <<'PY'
import json,sys
if json.load(open(sys.argv[1]))['status'] != 'Accepted': raise SystemExit('App notarization failed')
PY
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute "$app"
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")"
arch="$(lipo -archs "$app/Contents/MacOS/agent-auth-router-desktop")"
archive="$output/AgentAuthRouter_${version}_${arch}.app.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$archive" -C "$(dirname "$app")" "$(basename "$app")"
desktop/node_modules/.bin/tauri signer sign --app-version "$version" "$archive"
mkdir -p "$work/dmg"
ditto "$app" "$work/dmg/Agent Auth Router.app"
ln -s /Applications "$work/dmg/Applications"
dmg="$output/AgentAuthRouter_${version}_${arch}.dmg"
hdiutil create -volname 'Agent Auth Router' -srcfolder "$work/dmg" -ov -format UDZO "$dmg" >/dev/null
bash desktop/scripts/codesign-with-retry.sh --force --timestamp --sign "$MACOS_SIGNING_IDENTITY" "$dmg"
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$ASC_API_KEY_ID" --issuer "$ASC_API_ISSUER_ID" --wait --timeout 20m --output-format json > "$output/dmg-notarization.json"
python3 - "$output/dmg-notarization.json" <<'PY'
import json,sys
if json.load(open(sys.argv[1]))['status'] != 'Accepted': raise SystemExit('DMG notarization failed')
PY
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
node desktop/scripts/verify-package.mjs "$app" --signed > "$output/package-evidence.json"
(cd "$output" && shasum -a 256 *.dmg *.gz *.sig > SHA256SUMS)
