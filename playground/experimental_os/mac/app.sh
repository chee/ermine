#!/bin/sh
# app.sh: ermineOS as a Mac app, mac/build/ermineOS.app, from what ../newos/build.sh
# builds; signed, so macOS's grants (Accessibility, Screen Recording) stay with it
# across builds. The app holds its own files: the binary in Contents/MacOS, and in
# Contents/Resources newos's image, js/runner.js, fonts and the programs exec runs
# (build.sh's), where the metal (metal/main.swift, osPath) looks first.
#
#   sh app.sh            build it (../newos/build.sh -q), then bundle and sign it
#   sh app.sh bundle     bundle and sign what is built, no build
#   sh app.sh install    and copy it to ~/Applications
#
# Signing: ERMINE_SIGN, a code-signing identity (security find-identity -v -p
# codesigning); else the keychain's first Apple Development one, then Developer
# ID Application; else ad hoc ("-"), which macOS forgets the grants of at every
# build.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
os="$(cd "$here/../newos" && pwd)"
app="$here/build/ermineOS.app"
id=party.chee.ermineos

case "${1:-}" in
"" | install) sh "$os/build.sh" -q ;;
bundle) ;;
*) echo "usage: sh app.sh [bundle | install]" >&2; exit 2 ;;
esac

echo "bundling $app" >&2
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/js"
cp "$here/ermineOS" "$app/Contents/MacOS/ermineOS"
res="$app/Contents/Resources"
cp -R "$os/image" "$res/image"
cp "$os/js/runner.js" "$res/js/runner.js"
cp -R "$os/fonts" "$res/fonts"
cp -R "$here/build/newos/programs" "$res/programs"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>$id</string>
	<key>CFBundleName</key><string>ermineOS</string>
	<key>CFBundleDisplayName</key><string>ermineOS</string>
	<key>CFBundleExecutable</key><string>ermineOS</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1</string>
	<key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
EOF

# the identity: asked for, or the keychain's first fit, or ad hoc
sign="${ERMINE_SIGN:-}"
# for this Mac, Apple Development first; a Developer ID (for giving the app to others) after
if [ -z "$sign" ]; then
  sign="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)"
fi
if [ -z "$sign" ]; then
  sign="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)"
fi
if [ -z "$sign" ]; then
  sign=-
  echo "no signing identity in the keychain: signed ad hoc (grants are forgotten at each build)" >&2
fi
# the hardened runtime, for a Developer ID (notarizable); JavaScriptCore runs programs with its JIT, and
# Homebrew's OpenSSL, another team's library, is loaded, as native programs' libraries are (newos/dylib.c:
# signed ad hoc by the linker, so library validation off). Apple Development: no hardened runtime, so no
# library validation, and they load as they are
case "$sign" in
"Developer ID Application:"*)
  cat > "$here/build/ermineOS.entitlements" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.cs.allow-jit</key><true/>
	<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
EOF
  codesign --force --options runtime --entitlements "$here/build/ermineOS.entitlements" --timestamp -s "$sign" "$app"
  ;;
*) codesign --force -s "$sign" "$app" ;;
esac
echo "signed by: $sign" >&2
codesign --verify --strict "$app"
echo "built $app"

if [ "${1:-}" = install ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/ermineOS.app"
  cp -R "$app" "$HOME/Applications/ermineOS.app"
  echo "installed $HOME/Applications/ermineOS.app"
fi
