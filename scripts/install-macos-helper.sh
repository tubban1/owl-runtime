#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}/.."
SRC="$ROOT/macos-helper/ComputerMCPHelper.swift"
PLIST="$ROOT/macos-helper/Info.plist"
BUILD="$ROOT/build/macos-helper"
APP="$BUILD/OWL LAB Helper.app"
INSTALL_APP="$HOME/Applications/OWL LAB Helper.app"
SOCKET="${OWL_HELPER_SOCKET:-${COMPUTER_MCP_HELPER_SOCKET:-$HOME/.owl-runtime/helper.sock}}"

pkill -f "$INSTALL_APP/Contents/MacOS/ComputerMCPHelper" 2>/dev/null || true
rm -f "$SOCKET"
rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS"

xcrun swiftc \
  -O \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework Vision \
  "$SRC" \
  -o "$APP/Contents/MacOS/ComputerMCPHelper"

cp "$PLIST" "$APP/Contents/Info.plist"
chmod 755 "$APP/Contents/MacOS/ComputerMCPHelper"

codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

mkdir -p "$HOME/Applications" "${SOCKET:h}"
chmod 700 "${SOCKET:h}"
rm -rf "$INSTALL_APP"
ditto "$APP" "$INSTALL_APP"
codesign --force --deep --sign - "$INSTALL_APP"
codesign --verify --deep --strict "$INSTALL_APP"

"$INSTALL_APP/Contents/MacOS/ComputerMCPHelper" \
  --serve \
  --socket "$SOCKET" \
  >/dev/null 2>&1 &
HELPER_PID=$!
disown "$HELPER_PID" 2>/dev/null || true

for _ in {1..50}; do
  [[ -S "$SOCKET" ]] && break
  sleep 0.1
done

echo "Installed:"
echo "  $INSTALL_APP"
echo
echo "Unix socket:"
ls -l "$SOCKET" 2>/dev/null || echo "  helper socket not ready"
echo
echo "OWL LAB Helper is launched directly with an explicit Runtime-owned socket."
echo "Legacy ~/.computer-mcp/helper.sock is left untouched."
echo
echo "Grant permissions to 'OWL LAB Helper' in:"
echo "  System Settings → Privacy & Security → Accessibility"
echo "  System Settings → Privacy & Security → Screen & System Audio Recording"
echo
echo "To trigger both permission prompts:"
echo "  \"$INSTALL_APP/Contents/MacOS/ComputerMCPHelper\" --request-permissions"
