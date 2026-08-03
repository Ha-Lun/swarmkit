#!/bin/bash
# OpenCode config installer
# Usage: ./install.sh
# Interactive setup: creates auth.json, symlinks, and copies config files.

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$HOME"
AUTH_DIR="$HOME_DIR/.local/share/opencode"
AUTH_FILE="$AUTH_DIR/auth.json"

echo "========================================"
echo "  OpenCode Config Installer"
echo "========================================"
echo ""
echo "This script will:"
echo "  1. Check for existing config (and offer to back up/wipe if found)"
echo "  2. Set up API keys in \$HOME/.local/share/opencode/auth.json"
echo "  3. Create symlinks for agents, skills, and opencode.json"
echo "  4. Copy .claude configuration files"
echo "  5. Install npm dependencies in ~/.opencode/"
echo ""

# ========== Existing Config Detection ==========

echo ""
echo "=== Checking for Existing Config ==="

ALREADY_INSTALLED=false
HAS_EXISTING_CONFIG=false
EXISTING_PATHS=()
MERGE_MODE=false

# Check if already installed (agents symlinked to this repo)
if [ -L "$HOME_DIR/.opencode/agents" ] && [ "$(readlink "$HOME_DIR/.opencode/agents")" = "$REPO_DIR/agents" ]; then
  ALREADY_INSTALLED=true
fi

if [ "$ALREADY_INSTALLED" = true ]; then
  echo "✓ Existing config is already symlinked to this repo — skipping config check."
else
  # Check each config path for existing content
  for check_path in "$HOME_DIR/.opencode" "$HOME_DIR/.claude" "$HOME_DIR/.config/opencode"; do
    if [ -e "$check_path" ]; then
      if [ -d "$check_path" ]; then
        FILE_COUNT=$(find "$check_path" -type f 2>/dev/null | wc -l)
      else
        FILE_COUNT=1
      fi
      if [ "$FILE_COUNT" -gt 0 ]; then
        HAS_EXISTING_CONFIG=true
        EXISTING_PATHS+=("$check_path ($FILE_COUNT files)")
      fi
    fi
  done

  if [ "$HAS_EXISTING_CONFIG" = true ]; then
    echo ""
    echo "⚠️  Existing opencode config detected!"
    echo ""
    echo "Found:"
    for item in "${EXISTING_PATHS[@]}"; do
      echo "  - $item"
    done
    echo ""
    echo "Options:"
    echo "  1) Back up existing config and install fresh"
    echo "  2) Wipe existing config completely and install fresh"
    echo "  3) Merge (keep existing files, only add missing ones — NOT RECOMMENDED)"
    echo "  4) Cancel installation"
    echo ""
    read -rp "What would you like to do? (1/2/3/4): " CONFIG_CHOICE

    case "$CONFIG_CHOICE" in
      1)
        BACKUP_DIR="$HOME_DIR/.opencode-backup-$(date +%Y%m%d-%H%M%S)"
        echo ""
        echo "Backing up to: $BACKUP_DIR"
        mkdir -p "$BACKUP_DIR"
        for path in "$HOME_DIR/.opencode" "$HOME_DIR/.claude" "$HOME_DIR/.config/opencode"; do
          if [ -e "$path" ]; then
            mv "$path" "$BACKUP_DIR/"
          fi
        done
        echo "✓ Backup complete"
        ;;
      2)
        echo ""
        echo "Wiping existing config..."
        rm -rf "$HOME_DIR/.opencode" "$HOME_DIR/.claude" "$HOME_DIR/.config/opencode"
        echo "✓ Existing config wiped"
        ;;
      3)
        echo ""
        echo "⚠️  Merge mode selected — existing files will be kept, only missing files will be added."
        echo "   This may cause conflicts if existing config is incompatible."
        MERGE_MODE=true
        ;;
      4)
        echo "Installation cancelled."
        exit 0
        ;;
      *)
        echo "Invalid option. Cancelling installation."
        exit 1
        ;;
    esac
  fi
fi

# ========== API Key Setup ==========

mkdir -p "$AUTH_DIR"

FREE_MODE=false

# Check for existing auth.json
if [ -f "$AUTH_FILE" ]; then
  echo "Existing auth.json detected at: $AUTH_FILE"
  echo "  It contains keys for:"
  grep -o '"[a-z_-]*"' "$AUTH_FILE" | head -10 | sed 's/"//g' | sed 's/^/  - /' || true
  echo ""
  echo "What would you like to do?"
  select choice in "Overwrite (replace all keys)" "Keep (skip API setup)" "Merge (keep existing, add new ones)"; do
    case "$choice" in
      "Overwrite"*) AUTH_MODE="overwrite"; break;;
      "Keep"*)      AUTH_MODE="skip"; break;;
      "Merge"*)     AUTH_MODE="merge"; break;;
    esac
  done
fi

# Ask about free mode (only if we're going to prompt for keys)
if [ "${AUTH_MODE:-overwrite}" != "skip" ]; then
  echo ""
  echo "=== API Keys ==="
  echo "  Paid mode requires an opencode-go API key."
  echo "  Free mode uses default models and requires no keys."
  echo ""
  echo "  Get an opencode-go key at: https://opencode.ai/account/api-keys"
  echo ""
  read -rp "Do you have an opencode-go API key? (y/n): " HAS_OC_KEY
  case "$HAS_OC_KEY" in
    [Yy]*) FREE_MODE=false;;
    *)     FREE_MODE=true
           echo "  Free mode selected — agents will use default models."
           ;;
  esac
fi

build_auth() {
  local auth="{"
  local first=true

  if [ "$FREE_MODE" = false ]; then
    echo ""
    echo "=== OpenCode Go API Key (required) ==="
    echo "  Get yours at: https://opencode.ai/account/api-keys"
    echo ""
    read -rsp "OpenCode Go API Key: " OPENCODE_GO_KEY
    echo ""
    while [ -z "$OPENCODE_GO_KEY" ]; do
      echo "This key is required."
      read -rsp "OpenCode Go API Key: " OPENCODE_GO_KEY
      echo ""
    done
    auth+='"opencode-go": {"type": "api", "key": "'"$OPENCODE_GO_KEY"'"}'
    first=false
  fi

  auth+="}"
  echo "$auth"
}

NEW_AUTH=""

case "${AUTH_MODE:-overwrite}" in
  skip)
    echo "Keeping existing auth.json. Skipping API key setup."
    ;;
  merge)
    echo "Merging new keys into existing auth.json..."
    EXISTING_AUTH=$(cat "$AUTH_FILE")
    NEW_AUTH=$(build_auth)
    if command -v jq &>/dev/null; then
      echo "$EXISTING_AUTH" | jq --argjson new "$NEW_AUTH" '. + $new' > "$AUTH_FILE"
    else
      echo "$NEW_AUTH" > "$AUTH_FILE"
      echo "  (install jq for proper merge; fell back to overwrite)"
    fi
    echo "✓ auth.json updated."
    ;;
  *)
    NEW_AUTH=$(build_auth)
    if [ "$NEW_AUTH" != "{}" ]; then
      echo "$NEW_AUTH" > "$AUTH_FILE"
      echo "✓ API keys saved to $AUTH_FILE"
    else
      echo "No API keys to save. Skipping auth.json creation."
    fi
    ;;
esac

# ========== Symlinks ==========

echo ""
echo "=== Creating Symlinks ==="
mkdir -p "$HOME_DIR/.opencode"

if [ "$MERGE_MODE" = true ]; then
  # Merge: only symlink files that don't already exist
  [ ! -e "$HOME_DIR/.opencode/agents" ]       && ln -s "$REPO_DIR/agents"   "$HOME_DIR/.opencode/agents"
  [ ! -e "$HOME_DIR/.opencode/skills" ]       && ln -s "$REPO_DIR/skill"    "$HOME_DIR/.opencode/skills"
  [ ! -e "$HOME_DIR/.opencode/opencode.json" ] && ln -s "$REPO_DIR/opencode.jsonc" "$HOME_DIR/.opencode/opencode.json"
else
  ln -sf "$REPO_DIR/agents"   "$HOME_DIR/.opencode/agents"
  ln -sf "$REPO_DIR/skill"    "$HOME_DIR/.opencode/skills"
  ln -sf "$REPO_DIR/opencode.jsonc" "$HOME_DIR/.opencode/opencode.json"
fi
echo "✓ Symlinks created"

# ========== MCP Servers ==========

echo ""
echo "=== MCP Servers ==="
echo "4 MCP servers are configured in opencode.jsonc:"
echo "  - gemini-mcp-tool       (works out of the box)"
echo "  - shadcn                (works out of the box)"
echo "  - chrome-devtools       (works out of the box)"
echo "  - 21st-dev-magic        (needs a 21st.dev API key)"
echo ""

# Default to "no" (skip) so the script stays non-interactive-friendly
SETUP_MAGIC_KEY=""
MAGIC_KEY=""

read -rp "Set up the 21st.dev API key now? (y/N): " SETUP_MAGIC_KEY

if [ "$SETUP_MAGIC_KEY" = "y" ] || [ "$SETUP_MAGIC_KEY" = "Y" ]; then
  echo ""
  echo "Get a key at: https://21st.dev/mcp"
  read -rsp "21st.dev API key (input hidden): " MAGIC_KEY
  echo ""

  if [ -n "$MAGIC_KEY" ]; then
    BASHRC="$HOME/.bashrc"
    if [ -f "$BASHRC" ] && grep -q "MAGIC_MCP_API_KEY" "$BASHRC" 2>/dev/null; then
      echo ""
      echo "⚠️  MAGIC_MCP_API_KEY already exists in $BASHRC"
      echo "   Leaving it as-is. To update, edit $BASHRC manually."
    else
      {
        echo ""
        echo "# 21st.dev MCP API key (added by opencode-config installer)"
        echo "export MAGIC_MCP_API_KEY=\"$MAGIC_KEY\""
      } >> "$BASHRC"
      echo "✓ Added MAGIC_MCP_API_KEY to $BASHRC"
    fi
  else
    echo ""
    echo "⚠️  No key entered — skipping. See post-install instructions to set it up later."
    SETUP_MAGIC_KEY=""  # reset so post-install falls through to the "instructions" path
  fi
fi
echo ""

# ========== Free Mode: Comment Out Model Lines ==========

if [ "$FREE_MODE" = true ]; then
  echo ""
  echo "=== Free Mode ==="
  echo "Enabling free mode (commenting out model selections)..."
  for file in "$HOME_DIR/.opencode/agents/"*.md; do
    if [ -f "$file" ]; then
      sed -i 's/^model:/# model:/' "$file"
    fi
  done
  echo "✓ Model selections commented out — agents will use default models"
fi

# ========== .claude Config ==========

echo ""
echo "=== Copying .claude Config ==="
mkdir -p "$HOME_DIR/.claude"
count=0
for f in "$REPO_DIR/.claude/"*.md "$REPO_DIR/.claude/"*.json "$REPO_DIR/.claude/"*.sh; do
  if [ -f "$f" ]; then
    dest="$HOME_DIR/.claude/$(basename "$f")"
    if [ "$MERGE_MODE" = true ] && [ -f "$dest" ]; then
      echo "  Skipping (exists): $(basename "$f")"
    else
      cp "$f" "$dest"
      count=$((count + 1))
    fi
  fi
done
echo "✓ Copied $count files to ~/.claude/"

# ========== npm Install ==========

echo ""
echo "=== Installing npm Dependencies ==="
if [ -f "$HOME_DIR/.opencode/package.json" ]; then
  npm install --prefix "$HOME_DIR/.opencode" 2>&1 | tail -2
  echo "✓ npm dependencies installed"
else
  echo "No package.json found in ~/.opencode/, skipping npm install."
fi

# ========== Done ==========

echo ""
echo "========================================"
echo "  Installation Complete!"
echo "========================================"
echo ""

if [ "$FREE_MODE" = true ]; then
  echo "Free mode is active:"
  echo "  - Agents are using default models (model selections commented out)"
  echo "  - No API keys are configured"
  echo "  - To switch to paid mode later, run this installer again and get a key at:"
  echo "      opencode-go: https://opencode.ai/account/api-keys"
  echo ""
  echo "Next steps:"
  echo "  1. Restart opencode to apply changes"
  echo "  2. Verify your setup:"
  echo "       opencode doctor"
  echo ""
else
  echo "Next steps:"
  echo "  1. Restart opencode to apply changes"
  echo "  2. If you skipped Google/GitHub Copilot auth, run:"
  echo "       opencode auth login google"
  echo "       opencode auth login github-copilot"
  echo "  3. Verify your setup:"
  echo "       opencode doctor"
  echo ""
fi

# MCP server status
if [ "$SETUP_MAGIC_KEY" = "y" ] || [ "$SETUP_MAGIC_KEY" = "Y" ]; then
  if [ -n "$MAGIC_KEY" ]; then
    echo "MCP servers:"
    echo "  ✓ MAGIC_MCP_API_KEY added to ~/.bashrc"
    echo "  → Restart your shell or run: source ~/.bashrc"
    echo "  → Verify with: opencode mcp list"
    echo ""
  fi
else
  echo "MCP servers:"
  echo "  3 of 4 MCPs work out of the box (gemini-mcp-tool, shadcn, chrome-devtools)"
  echo "  21st-dev-magic needs MAGIC_MCP_API_KEY in your shell. To set it up:"
  echo "    1. Get a key at: https://21st.dev/mcp"
  echo "    2. Add to ~/.bashrc:  export MAGIC_MCP_API_KEY=\"21st_sk_...\""
  echo "    3. Reload:  source ~/.bashrc"
  echo "  → Verify with: opencode mcp list"
  echo ""
fi

echo "Happy coding!"
