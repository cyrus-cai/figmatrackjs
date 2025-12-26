#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Config
INSTALL_DIR="$HOME/.figmatrack"
BIN_DIR="$HOME/.local/bin"
PLIST_PATH="$HOME/Library/LaunchAgents/com.tracker.figma.plist"

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo ""
echo -e "${RED}FigmaTrack Uninstaller${NC}"
echo ""

# Stop scheduled task if running (macOS)
if [ -f "$PLIST_PATH" ]; then
    info "Stopping scheduled task..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    success "Scheduled task removed"
fi

# Remove symlink from ~/.local/bin
if [ -L "$BIN_DIR/ft" ]; then
    info "Removing 'ft' command from $BIN_DIR..."
    rm -f "$BIN_DIR/ft"
    success "Command removed from $BIN_DIR"
fi

# Remove from ~/.bun/bin (if installed via bun link/global)
BUN_BIN_DIR="$HOME/.bun/bin"
if [ -f "$BUN_BIN_DIR/ft" ] || [ -L "$BUN_BIN_DIR/ft" ]; then
    info "Removing 'ft' command from $BUN_BIN_DIR..."
    rm -f "$BUN_BIN_DIR/ft"
    success "Command removed from $BUN_BIN_DIR"
fi

# Ask about data
if [ -d "$INSTALL_DIR" ]; then
    echo ""
    read -p "Remove data and tracked files? (y/N): " remove_data

    if [ "$remove_data" = "y" ] || [ "$remove_data" = "Y" ]; then
        info "Removing all data..."
        rm -rf "$INSTALL_DIR"
        success "All data removed"
    else
        info "Removing program files only..."
        rm -rf "$INSTALL_DIR/src" "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules" \
               "$INSTALL_DIR/package.json" "$INSTALL_DIR/bun.lockb" \
               "$INSTALL_DIR/install.sh" "$INSTALL_DIR/uninstall.sh" 2>/dev/null || true
        success "Program files removed (data preserved in $INSTALL_DIR)"
    fi
fi

echo ""
echo -e "${GREEN}FigmaTrack has been uninstalled.${NC}"
echo ""
