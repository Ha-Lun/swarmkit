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

# Copy .claude config files (these can't be symlinked because opencode expects them in place)
# Only copies config files — not skills (those are Gemini-managed, 76 MB)
echo "Copying .claude config files..."
mkdir -p "$HOME_DIR/.claude"
for f in "$REPO_DIR/.claude/"*.md "$REPO_DIR/.claude/"*.json "$REPO_DIR/.claude/"*.sh; do
  [ -f "$f" ] && cp "$f" "$HOME_DIR/.claude/"
done

echo "✓ Config installed. Restart opencode to apply changes."
