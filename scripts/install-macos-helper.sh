#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}/.."
SRC="$ROOT/macos-helper/ComputerMCPHelper.swift"
PLIST="$ROOT/macos-helper/Info.plist"
BUILD="$ROOT/build/macos-helper"
APP="$BUILD/Computer MCP Helper.app"
INSTALL_APP="$HOME/Applications/Computer MCP Helper.app"
SOCKET="$HOME/.computer-mcp/helper.sock"

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

mkdir -p "$HOME/Applications" "$HOME/.computer-mcp"
chmod 700 "$HOME/.computer-mcp"
rm -rf "$INSTALL_APP"
ditto "$APP" "$INSTALL_APP"
codesign --force --deep --sign - "$INSTALL_APP"
codesign --verify --deep --strict "$INSTALL_APP"

open -gj "$INSTALL_APP" --args --serve
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
echo "The helper is now launched by macOS LaunchServices, not by your IDE/Terminal."
echo "Grant permissions to 'Computer MCP Helper' in:"
echo "  System Settings → Privacy & Security → Accessibility"
echo "  System Settings → Privacy & Security → Screen & System Audio Recording"
echo
echo "To trigger both permission prompts:"
echo "  open \"$INSTALL_APP\" --args --request-permissions"
