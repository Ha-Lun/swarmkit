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
echo "  1. Set up API keys in \$HOME/.local/share/opencode/auth.json"
echo "  2. Create symlinks for agents, skills, and opencode.json"
echo "  3. Copy .claude configuration files"
echo "  4. Install npm dependencies in ~/.opencode/"
echo ""

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
  echo "  Paid mode requires both opencode-go and NVIDIA API keys."
  echo "  Free mode uses default models and requires no keys."
  echo ""
  echo "  Get an opencode-go key at: https://opencode.ai/account/api-keys"
  echo "  Get an NVIDIA key at:      https://build.nvidia.com/"
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

  if [ "$FREE_MODE" = false ]; then
    echo ""
    echo "=== NVIDIA NIM (required) ==="
    echo "  Models: Llama, Nemotron, etc. Get key at: https://build.nvidia.com/"
    echo "  Required — agents (docker-specialist, server-specialist) use nvidia models."
    echo ""
    read -rsp "NVIDIA API Key: " NVIDIA_KEY
    echo ""
    while [ -z "$NVIDIA_KEY" ]; do
      echo "This key is required."
      read -rsp "NVIDIA API Key: " NVIDIA_KEY
      echo ""
    done
    if [ "$first" = false ]; then auth+=","; fi
    auth+='"nvidia": {"type": "api", "key": "'"$NVIDIA_KEY"'"}'
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
ln -sf "$REPO_DIR/agents"   "$HOME_DIR/.opencode/agents"
ln -sf "$REPO_DIR/skill"    "$HOME_DIR/.opencode/skills"
ln -sf "$REPO_DIR/opencode.jsonc" "$HOME_DIR/.opencode/opencode.json"
echo "✓ Symlinks created"

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
    cp "$f" "$HOME_DIR/.claude/"
    count=$((count + 1))
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
  echo "  - To switch to paid mode later, run this installer again and get keys at:"
  echo "      opencode-go: https://opencode.ai/account/api-keys"
  echo "      NVIDIA:      https://build.nvidia.com/"
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

echo "Happy coding!"
