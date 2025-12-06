#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Config
INSTALL_DIR="$HOME/.figmatrack"
BIN_DIR="$HOME/.local/bin"
REPO_URL="https://github.com/cyrus-cai/figmatrackjs"

print_banner() {
    echo -e "${BLUE}"
    echo "  _____ _                     _____               _    "
    echo " |  ___(_) __ _ _ __ ___   __|_   _| __ __ _  ___| | __"
    echo " | |_  | |/ _\` | '_ \` _ \ / _\` || || '__/ _\` |/ __| |/ /"
    echo " |  _| | | (_| | | | | | | (_| || || | | (_| | (__|   < "
    echo " |_|   |_|\__, |_| |_| |_|\__,_||_||_|  \__,_|\___|_|\_\\"
    echo "          |___/                                         "
    echo -e "${NC}"
    echo "Figma Community Stats Tracker - Installer"
    echo ""
}

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin*)    OS="macos" ;;
        Linux*)     OS="linux" ;;
        *)          error "Unsupported OS: $(uname -s)" ;;
    esac
    info "Detected OS: $OS"
}

# Check if Bun is installed
check_bun() {
    if command -v bun &> /dev/null; then
        BUN_VERSION=$(bun --version)
        success "Bun is installed (v$BUN_VERSION)"
        return 0
    else
        return 1
    fi
}

# Install Bun
install_bun() {
    info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash

    # Source the updated profile
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if command -v bun &> /dev/null; then
        success "Bun installed successfully"
    else
        error "Bun installation failed. Please install manually: https://bun.sh"
    fi
}

# Create directories
setup_directories() {
    info "Setting up directories..."

    mkdir -p "$INSTALL_DIR"
    mkdir -p "$BIN_DIR"
    mkdir -p "$INSTALL_DIR/data"

    success "Directories created"
}

# Download project
download_project() {
    info "Downloading FigmaTrack..."

    if [ -d "$INSTALL_DIR/src" ]; then
        warn "Existing installation found, updating..."
        rm -rf "$INSTALL_DIR/src" "$INSTALL_DIR/dist" "$INSTALL_DIR/package.json" 2>/dev/null || true
    fi

    # Try git clone first
    if command -v git &> /dev/null; then
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR/repo" 2>/dev/null || {
            # Fallback to tarball download
            info "Git clone failed, trying tarball download..."
            curl -fsSL "${REPO_URL}/archive/refs/heads/main.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1
        }

        if [ -d "$INSTALL_DIR/repo" ]; then
            mv "$INSTALL_DIR/repo"/* "$INSTALL_DIR/"
            rm -rf "$INSTALL_DIR/repo"
        fi
    else
        # Download as tarball
        curl -fsSL "${REPO_URL}/archive/refs/heads/main.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1
    fi

    success "Downloaded FigmaTrack"
}

# Build project
build_project() {
    info "Building FigmaTrack..."

    cd "$INSTALL_DIR"
    bun install
    bun run build

    success "Build completed"
}

# Create symlink
create_symlink() {
    info "Creating 'ft' command..."

    # Remove existing symlink if exists
    rm -f "$BIN_DIR/ft" 2>/dev/null || true

    # Create new symlink
    ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_DIR/ft"
    chmod +x "$INSTALL_DIR/dist/cli.js"

    success "Created 'ft' command"
}

# Update PATH in shell config
update_path() {
    local shell_config=""
    local path_line='export PATH="$HOME/.local/bin:$PATH"'

    # Detect shell config file
    if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
        shell_config="$HOME/.zshrc"
    elif [ -n "$BASH_VERSION" ] || [ -f "$HOME/.bashrc" ]; then
        shell_config="$HOME/.bashrc"
    elif [ -f "$HOME/.profile" ]; then
        shell_config="$HOME/.profile"
    fi

    if [ -n "$shell_config" ]; then
        # Check if PATH already includes .local/bin
        if ! grep -q '.local/bin' "$shell_config" 2>/dev/null; then
            info "Adding ~/.local/bin to PATH in $shell_config"
            echo "" >> "$shell_config"
            echo "# FigmaTrack" >> "$shell_config"
            echo "$path_line" >> "$shell_config"
            success "Updated $shell_config"
        fi
    fi

    # Export for current session
    export PATH="$HOME/.local/bin:$PATH"
}

# Verify installation
verify_installation() {
    info "Verifying installation..."

    if [ -x "$BIN_DIR/ft" ]; then
        success "Installation verified!"
    else
        error "Installation verification failed"
    fi
}

# Print completion message
print_completion() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  FigmaTrack installed successfully!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "Usage:"
    echo "  ft --add <URL>       # Add a Figma Community file to track"
    echo "  ft --remove <ID>     # Remove a file from tracking"
    echo "  ft --list            # List all tracked files"
    echo "  ft --run             # Collect stats now"
    echo "  ft --schedule HH:MM  # Set daily auto-collection time"
    echo "  ft --unschedule      # Cancel scheduled task"
    echo "  ft --status          # Check schedule status"
    echo ""
    echo -e "${YELLOW}NOTE: Run 'source ~/.zshrc' or restart your terminal to use 'ft' command${NC}"
    echo ""
    echo "Data stored in: $INSTALL_DIR/data"
    echo ""
}

# Main
main() {
    print_banner
    detect_os

    # Check and install Bun
    if ! check_bun; then
        install_bun
    fi

    setup_directories
    download_project
    build_project
    create_symlink
    update_path
    verify_installation
    print_completion
}

main "$@"
