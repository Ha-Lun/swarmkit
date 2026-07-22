#!/bin/bash
# OpenCode config installer
# Usage: ./install.sh

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$HOME"

echo "Installing opencode config from $REPO_DIR..."

# Create symlinks
echo "Creating symlinks..."
ln -sf "$REPO_DIR/agents" "$HOME_DIR/.opencode/agents"
ln -sf "$REPO_DIR/skill" "$HOME_DIR/.opencode/skills"
ln -sf "$REPO_DIR/opencode.jsonc" "$HOME_DIR/.opencode/opencode.json"

# Copy .claude files (these can't be symlinked because opencode expects them in place)
echo "Copying .claude config files..."
mkdir -p "$HOME_DIR/.claude"
cp -r "$REPO_DIR/.claude/"* "$HOME_DIR/.claude/" 2>/dev/null || true

echo "✓ Config installed. Restart opencode to apply changes."
