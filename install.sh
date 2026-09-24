#!/usr/bin/env bash
# SwarmKit Unified Installer
# Usage: ./install.sh [options]
# Options:
#   --opencode    Install OpenCode config
#   --agy         Install Antigravity (agy) Swarm config
#   --claude      Install Claude Code Swarm config
#   --n8n         Configure local self-hosted n8n credentials (optional add-on, not in --all)
#   --cloudflare  Install Cloudflare skills and configure auth (optional add-on, not in --all)
#   --all         Install all agent configs (opencode, agy, claude)
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
INSTALL_N8N=false
INSTALL_CLOUDFLARE=false
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
      --n8n)      INSTALL_N8N=true ;;
      --cloudflare) INSTALL_CLOUDFLARE=true ;;
      --all)      
        INSTALL_OPENCODE=true
        INSTALL_AGY=true
        INSTALL_CLAUDE=true
        ;;
      --free)     FREE_MODE=true ;;
      --uninstall)UNINSTALL_MODE=true ;;
      --help)
        sed -n '2,12p' "$0" | sed 's/^# *//'
        exit 0
        ;;
      *)
        echo "Unknown option: $arg"
        exit 1
        ;;
    esac
  done
fi

OPENCODE_DIR="$HOME/.config/opencode"
GEMINI_DIR="$HOME/.gemini/config"
CLAUDE_DIR="$HOME/.claude"

# Remove symlinks in a directory that point into this repo but no longer resolve
# (e.g. after files moved inside the repo).
prune_dead_repo_links() {
  local dir="$1" link
  [ -d "$dir" ] || return 0
  for link in "$dir"/*; do
    if [ -L "$link" ] && [ ! -e "$link" ] && [[ "$(readlink "$link")" == "$REPO_DIR"/* ]]; then
      rm -f "$link"
    fi
  done
}

# Remove symlinks in a directory that point into this repo.
remove_repo_links() {
  local dir="$1" link
  [ -d "$dir" ] || return 0
  for link in "$dir"/*; do
    if [ -L "$link" ] && [[ "$(readlink "$link")" == "$REPO_DIR"/* ]]; then
      rm -f "$link"
    fi
  done
}

if [ "$UNINSTALL_MODE" = true ]; then
  echo "Uninstalling configurations..."
  for d in "$OPENCODE_DIR" "$OPENCODE_DIR/skills" "$CLAUDE_DIR" "$CLAUDE_DIR/skills" "$CLAUDE_DIR/hooks" \
           "$GEMINI_DIR/plugins" "$GEMINI_DIR/skills" "$HOME/.opencode"; do
    remove_repo_links "$d"
  done
  rm -f "$GEMINI_DIR/mcp_config.json"
  echo "Uninstall complete. MCP servers registered with 'claude mcp' are left in place."
  exit 0
fi

backup_if_exists() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    if [ "$CREATED_BACKUP" = false ]; then
      mkdir -p "$BACKUP_DIR"
      CREATED_BACKUP=true
      echo "Created backup directory: $BACKUP_DIR"
    fi
    # Name backups by their path under $HOME so same-named files can't collide.
    local rel="${path#$HOME/}"
    cp -R "$path" "$BACKUP_DIR/${rel//\//__}" 2>/dev/null || true
  fi
}

# Back up whatever is at $2 (unless it already links into this repo), then symlink $1 there.
link() {
  local src="$1" dest="$2"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [[ "$(readlink "$dest" 2>/dev/null)" != "$REPO_DIR"/* ]]; then
      backup_if_exists "$dest"
    fi
    rm -rf "$dest"
  fi
  ln -s "$src" "$dest"
}

# Symlink every shared skill into $1, dropping links left over from old repo paths.
link_skills() {
  local dest="$1" skill_dir
  mkdir -p "$dest"
  prune_dead_repo_links "$dest"
  for skill_dir in "$REPO_DIR"/core/skills/*/; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    ln -sfn "${skill_dir%/}" "$dest/$(basename "$skill_dir")"
  done
}

install_opencode() {
  echo "=== Installing OpenCode Config ==="
  mkdir -p "$OPENCODE_DIR"

  # Old installs linked into ~/.opencode (OpenCode's install dir); drop those links.
  remove_repo_links "$HOME/.opencode"

  link "$REPO_DIR/opencode/agents" "$OPENCODE_DIR/agents"
  link "$REPO_DIR/opencode/AGENTS.md" "$OPENCODE_DIR/AGENTS.md"
  link "$REPO_DIR/opencode/command" "$OPENCODE_DIR/command"
  link_skills "$OPENCODE_DIR/skills"

  if [ "$FREE_MODE" = true ]; then
    echo "Free mode: Creating customized opencode.jsonc without explicit models..."
    backup_if_exists "$OPENCODE_DIR/opencode.jsonc"
    rm -f "$OPENCODE_DIR/opencode.jsonc"
    sed 's/"model": ".*"/"model": "opencode\/nemotron-3.5-lightning-free"/' "$REPO_DIR/opencode/opencode.jsonc" > "$OPENCODE_DIR/opencode.jsonc"
  else
    link "$REPO_DIR/opencode/opencode.jsonc" "$OPENCODE_DIR/opencode.jsonc"
  fi

  if [ ! -f "$OPENCODE_DIR/custom-instructions.md" ]; then
    cp "$REPO_DIR/opencode/custom-instructions.md.example" "$OPENCODE_DIR/custom-instructions.md"
  fi

  echo "✓ OpenCode installation complete"
}

install_agy() {
  echo "=== Installing Antigravity Swarm (agy) Config ==="
  mkdir -p "$GEMINI_DIR/plugins"

  # Rules and specialists now ship in the swarmkit plugin; remove the old copies.
  for old in "$GEMINI_DIR/AGENTS.md" "$GEMINI_DIR/GEMINI.md" "$GEMINI_DIR/agents"; do
    if [ -e "$old" ] || [ -L "$old" ]; then
      [[ "$(readlink "$old" 2>/dev/null)" == "$REPO_DIR"/* ]] || backup_if_exists "$old"
      rm -rf "$old"
    fi
  done

  link "$REPO_DIR/antigravity/plugins/swarmkit" "$GEMINI_DIR/plugins/swarmkit"
  link_skills "$GEMINI_DIR/skills"
  if ! cmp -s "$REPO_DIR/core/mcp.json" "$GEMINI_DIR/mcp_config.json"; then
    backup_if_exists "$GEMINI_DIR/mcp_config.json"
    cp "$REPO_DIR/core/mcp.json" "$GEMINI_DIR/mcp_config.json"
  fi

  # Install agyw account switcher
  if command -v npm &>/dev/null; then
    echo "Installing agyw (account switcher)..."
    npm install -g agyw
    if [ -d "$HOME/.gemini/antigravity-cli" ]; then
      agyw init
      echo "✓ agyw installed and initialized"
    else
      echo "✓ agyw installed. Run 'agyw init' after launching agy for the first time."
    fi
  else
    echo "⚠ npm not found — skipping agyw. Install Node.js then run: npm install -g agyw && agyw init"
  fi

  echo "✓ Antigravity (agy) installation complete"
}

install_claude() {
  echo "=== Installing Claude Code Config ==="
  mkdir -p "$CLAUDE_DIR/hooks"

  link "$REPO_DIR/claude/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
  link "$REPO_DIR/claude/agents" "$CLAUDE_DIR/agents"
  link "$REPO_DIR/claude/hooks/guard.py" "$CLAUDE_DIR/hooks/guard.py"
  link_skills "$CLAUDE_DIR/skills"

  # MCP servers: register each one at user scope unless it already exists.
  if command -v claude &>/dev/null; then
    local name
    for name in $(python3 -c "import json;print(' '.join(json.load(open('$REPO_DIR/core/mcp.json'))['mcpServers']))"); do
      if claude mcp get "$name" &>/dev/null; then
        echo "  MCP '$name' already registered, skipping"
      else
        claude mcp add-json -s user "$name" \
          "$(python3 -c "import json;s=json.load(open('$REPO_DIR/core/mcp.json'))['mcpServers']['$name'];'url' in s and s.setdefault('type','http');print(json.dumps(s))")"
      fi
    done
  else
    echo "⚠ claude CLI not found — skipping MCP registration"
  fi

  echo "✓ Claude Code installation complete"
}

install_n8n() {
  echo "=== Configuring local n8n Credentials ==="
  local n8n_env_dir="$HOME/.config/swarmkit"
  local n8n_env_file="$n8n_env_dir/n8n.env"
  mkdir -p "$n8n_env_dir"
  chmod 700 "$n8n_env_dir"

  if [ -t 0 ]; then
    echo "This will link your local n8n instance to the swarm."
    echo "Your credentials will be stored securely in $n8n_env_file and never committed."
    local n8n_url=""
    while true; do
      read -p "Enter your n8n API URL (e.g. http://localhost:5678/api/v1): " n8n_url
      if [ -z "$n8n_url" ] || [[ "$n8n_url" != http* ]]; then
        echo "Error: URL cannot be empty and must start with http or https."
      else
        break
      fi
    done

    local n8n_key=""
    while true; do
      read -sp "Enter your n8n API Key: " n8n_key
      echo ""
      if [ -z "$n8n_key" ]; then
        echo "Error: API key cannot be empty."
      else
        break
      fi
    done

    touch "$n8n_env_file" && chmod 600 "$n8n_env_file"
    printf 'export N8N_API_URL=%q\n' "$n8n_url" > "$n8n_env_file"
    printf 'export N8N_API_KEY=%q\n' "$n8n_key" >> "$n8n_env_file"
    echo "✓ Saved n8n credentials to $n8n_env_file"
    
    echo "To use these in your shell, add this to your ~/.bashrc or ~/.zshrc:"
    echo "  source $n8n_env_file"
  else
    echo "Non-interactive mode. Please manually create $n8n_env_file with N8N_API_URL and N8N_API_KEY, or export them in your shell profile."
  fi
  echo "✓ n8n configuration complete"
}

install_cloudflare() {
  echo "=== Installing Cloudflare Skills & Config ==="
  echo "Installing Cloudflare skills globally..."
  npx -y skills add cloudflare/skills --skill '*' --yes --global || true
  echo "ℹ Note: PromptScript failures are expected and non-fatal (skills.sh platform limitation)."

  if command -v opencode &> /dev/null; then
    echo "Authenticating OpenCode with Cloudflare MCP..."
    opencode mcp auth cloudflare || echo "⚠ Cloudflare MCP auth was not completed. Run manually when ready: opencode mcp auth cloudflare"
  else
    echo "ℹ opencode CLI not found. Skipping auth step."
  fi
  echo "✓ Cloudflare installation complete"
}

if [ "$INSTALL_OPENCODE" = true ]; then install_opencode; fi
if [ "$INSTALL_AGY" = true ]; then install_agy; fi
if [ "$INSTALL_CLAUDE" = true ]; then install_claude; fi
if [ "$INSTALL_N8N" = true ]; then install_n8n; fi
if [ "$INSTALL_CLOUDFLARE" = true ]; then install_cloudflare; fi

echo ""
echo "========================================"
echo "  Installation Successful! 🎉"
echo "========================================"
echo "Restart your terminal or tools for changes to take effect."
