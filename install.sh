#!/usr/bin/env bash
# SwarmKit Unified Installer
# Usage: ./install.sh [options]
# Options:
#   --opencode    Install OpenCode config
#   --agy         Install Antigravity (agy) Swarm config
#   --claude      Install Claude Code Swarm config
#   --all         Install all of the above
#   --free        Enable free mode for OpenCode (uses default models, no keys)
#   --uninstall   Uninstall all configurations
#   --help        Show this help message

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$HOME/.opencode-backup-$(date +%Y%m%d-%H%M%S)"
CREATED_BACKUP=false

# Flag variables
INSTALL_OPENCODE=false
INSTALL_AGY=false
INSTALL_CLAUDE=false
FREE_MODE=false
UNINSTALL_MODE=false

# Parse arguments
if [ $# -eq 0 ]; then
  # Interactive mode fallback if no flags provided
  echo "No flags provided. Installing all configs by default."
  INSTALL_OPENCODE=true
  INSTALL_AGY=true
  INSTALL_CLAUDE=true
else
  for arg in "$@"; do
    case $arg in
      --opencode) INSTALL_OPENCODE=true ;;
      --agy)      INSTALL_AGY=true ;;
      --claude)   INSTALL_CLAUDE=true ;;
      --all)      
        INSTALL_OPENCODE=true
        INSTALL_AGY=true
        INSTALL_CLAUDE=true
        ;;
      --free)     FREE_MODE=true ;;
      --uninstall)UNINSTALL_MODE=true ;;
      --help)
        sed -n '2,11p' "$0" | sed 's/^# *//'
        exit 0
        ;;
      *)
        echo "Unknown option: $arg"
        exit 1
        ;;
    esac
  done
fi

if [ "$UNINSTALL_MODE" = true ]; then
  echo "Uninstalling configurations..."
  rm -f "$HOME/.opencode/opencode.json"
  rm -f "$HOME/.opencode/agents"
  rm -f "$HOME/.opencode/skills"
  rm -rf "$HOME/.gemini/config/AGENTS.md" "$HOME/.gemini/config/GEMINI.md" "$HOME/.gemini/config/skills" "$HOME/.gemini/config/mcp_config.json"
  rm -f "$HOME/.claude.md"
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/claude"
  echo "Uninstall complete."
  exit 0
fi

# Detect shell
USER_SHELL=$(basename "$SHELL")
RC_FILE=""
case "$USER_SHELL" in
  bash) RC_FILE="$HOME/.bashrc" ;;
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

backup_if_exists() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    if [ "$CREATED_BACKUP" = false ]; then
      mkdir -p "$BACKUP_DIR"
      CREATED_BACKUP=true
      echo "Created backup directory: $BACKUP_DIR"
    fi
    cp -R "$path" "$BACKUP_DIR/$(basename "$path")-$(date +%s)" 2>/dev/null || true
  fi
}

install_opencode() {
  echo "=== Installing OpenCode Config ==="
  mkdir -p "$HOME/.opencode"
  mkdir -p "$HOME/.config/opencode"

  backup_if_exists "$HOME/.opencode/agents"
  backup_if_exists "$HOME/.opencode/skills"
  backup_if_exists "$HOME/.opencode/opencode.json"

  ln -sfn "$REPO_DIR/agents" "$HOME/.opencode/agents"
  ln -sfn "$REPO_DIR/skill" "$HOME/.opencode/skills"
  
  if [ "$FREE_MODE" = true ]; then
    echo "Free mode: Creating customized opencode.jsonc without explicit models..."
    # We do not dirty the repo file, we just sed it dynamically on installation
    sed 's/"model": ".*"/"model": "opencode\/nemotron-3.5-lightning-free"/' "$REPO_DIR/opencode.jsonc" > "$HOME/.opencode/opencode.json"
  else
    ln -sfn "$REPO_DIR/opencode.jsonc" "$HOME/.opencode/opencode.json"
  fi

  if [ ! -f "$HOME/.config/opencode/custom-instructions.md" ]; then
    cp "$REPO_DIR/custom-instructions.md.example" "$HOME/.config/opencode/custom-instructions.md"
  fi

  echo "✓ OpenCode installation complete"
}

install_agy() {
  echo "=== Installing Antigravity Swarm (agy) Config ==="
  local gemini_dir="$HOME/.gemini/config"
  mkdir -p "$gemini_dir/skills"

  backup_if_exists "$gemini_dir/AGENTS.md"
  backup_if_exists "$gemini_dir/GEMINI.md"
  backup_if_exists "$gemini_dir/mcp_config.json"

  cp "$REPO_DIR/AGENTS.md" "$gemini_dir/AGENTS.md"
  cp "$REPO_DIR/AGENTS.md" "$gemini_dir/GEMINI.md"
  cp "$REPO_DIR/mcp.json" "$gemini_dir/mcp_config.json"

  for skill_dir in "$REPO_DIR"/skill/*; do
    if [ -d "$skill_dir" ]; then
      ln -sfn "$skill_dir" "$gemini_dir/skills/$(basename "$skill_dir")"
    fi
  done

  # Configure .agents in the repo safely without dirtying git if possible
  # Since .agents is gitignored, this is fine
  mkdir -p "$REPO_DIR/.agents/skills"
  mkdir -p "$REPO_DIR/.agents/rules"
  cp "$REPO_DIR/AGENTS.md" "$REPO_DIR/.agents/rules/AGENTS.md"
  cp "$REPO_DIR/mcp.json" "$REPO_DIR/.agents/mcp_config.json"

  for skill_dir in "$REPO_DIR"/skill/*; do
    if [ -d "$skill_dir" ]; then
      ln -sfn "$skill_dir" "$REPO_DIR/.agents/skills/$(basename "$skill_dir")"
    fi
  done

  echo "✓ Antigravity (agy) installation complete"
}

install_claude() {
  echo "=== Installing Claude Code Config ==="
  local claude_global="${XDG_CONFIG_HOME:-$HOME/.config}/claude"
  mkdir -p "$claude_global"
  
  backup_if_exists "$HOME/.claude.md"
  backup_if_exists "$claude_global/claude.json"

  cp "$REPO_DIR/AGENTS.md" "$HOME/.claude.md"
  cp "$REPO_DIR/mcp.json" "$claude_global/claude.json"

  echo "✓ Claude Code installation complete"
}

if [ "$INSTALL_OPENCODE" = true ]; then install_opencode; fi
if [ "$INSTALL_AGY" = true ]; then install_agy; fi
if [ "$INSTALL_CLAUDE" = true ]; then install_claude; fi

echo ""
echo "========================================"
echo "  Installation Successful! 🎉"
echo "========================================"
echo "Restart your terminal or tools for changes to take effect."
