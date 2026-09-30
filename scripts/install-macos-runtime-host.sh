#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}/.."
SRC="$ROOT/macos-runtime-host/OwlRuntimeHost.swift"
PLIST="$ROOT/macos-runtime-host/Info.plist"
BUILD="$ROOT/build/macos-runtime-host-$$"
APP="$BUILD/OWL Runtime.app"
trap 'rm -rf "$BUILD"' EXIT INT TERM
INSTALL_APP="$HOME/Applications/OWL Runtime.app"
SIGN_IDENTITY="${OWL_RUNTIME_HOST_SIGN_IDENTITY:--}"
ALLOW_HOST_UPDATE="${ALLOW_OWL_RUNTIME_HOST_UPDATE:-false}"

VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST")
BUILD_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$PLIST")
SOURCE_FINGERPRINT=$(
  {
    shasum -a 256 "$SRC" | awk '{print $1}'
    shasum -a 256 "$PLIST" | awk '{print $1}'
  } | shasum -a 256 | awk '{print $1}'
)
INSTALLED_FINGERPRINT_FILE="$INSTALL_APP/Contents/Resources/source.sha256"

installed_version() {
  [[ -f "$INSTALL_APP/Contents/Info.plist" ]] || return 1
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INSTALL_APP/Contents/Info.plist" 2>/dev/null
}

installed_fingerprint() {
  [[ -f "$INSTALLED_FINGERPRINT_FILE" ]] || return 1
  tr -d '[:space:]' < "$INSTALLED_FINGERPRINT_FILE"
}

if [[ -d "$INSTALL_APP" ]]; then
  EXISTING_FINGERPRINT="$(installed_fingerprint || true)"
  EXISTING_VERSION="$(installed_version || true)"

  if [[ "$EXISTING_FINGERPRINT" == "$SOURCE_FINGERPRINT" ]]; then
    echo "OWL Runtime Host is unchanged; preserving its stable macOS permission identity."
    echo "  app:     $INSTALL_APP"
    echo "  version: ${EXISTING_VERSION:-unknown}"
    exit 0
  fi

  if [[ "$ALLOW_HOST_UPDATE" != "true" ]]; then
    echo "Refusing to replace the installed OWL Runtime Host automatically."
    echo "The permission-bearing host has an independent lifecycle from ordinary Runtime releases."
    echo "Installed version: ${EXISTING_VERSION:-unknown}"
    echo "Candidate version: $VERSION"
    echo
    echo "If this is an intentional native host update, review macOS permissions and run:"
    echo "  ALLOW_OWL_RUNTIME_HOST_UPDATE=true npm run install:runtime-host"
    exit 1
  fi
fi

echo "Installing OWL Runtime Host $VERSION ($BUILD_VERSION)"
echo "  stable path: $INSTALL_APP"
echo "  bundle id:   $(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$PLIST")"
echo "  signer:      $SIGN_IDENTITY"

rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

xcrun swiftc -O "$SRC" -o "$APP/Contents/MacOS/OwlRuntimeHost"
cp "$PLIST" "$APP/Contents/Info.plist"
printf '%s\n' "$SOURCE_FINGERPRINT" > "$APP/Contents/Resources/source.sha256"
chmod 755 "$APP/Contents/MacOS/OwlRuntimeHost"

codesign --force --deep --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"

mkdir -p "$HOME/Applications"
rm -rf "$INSTALL_APP"
ditto "$APP" "$INSTALL_APP"
codesign --force --deep --sign "$SIGN_IDENTITY" "$INSTALL_APP"
codesign --verify --deep --strict "$INSTALL_APP"

echo "Installed:"
echo "  $INSTALL_APP"
echo
echo "Grant Full Disk Access once to 'OWL Runtime' in:"
echo "  System Settings → Privacy & Security → Full Disk Access"
echo
echo "Ordinary OWL Runtime 1.x code releases must not replace this permission-bearing app."
