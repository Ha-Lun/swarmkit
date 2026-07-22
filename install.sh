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

build_auth() {
  local auth="{"
  local first=true

  # opencode-go (required)
  echo ""
  echo "=== OpenCode Go API Key (required) ==="
  echo "  Get yours at: https://opencode.ai/account/api-keys"
  echo "  (or copy the key from your existing auth.json on another machine)"
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

  # --- Optional providers ---
  echo ""
  echo "=== Optional Providers ==="
  echo "You can add additional API keys for other models."
  echo "Leave blank or type 'skip' for any provider you don't need."
  echo ""

  # NVIDIA
  echo "--- NVIDIA NIM ---"
  echo "  Models: Llama, Nemotron, etc. Get key at: https://build.nvidia.com/"
  read -rp "NVIDIA API Key (or skip): " NVIDIA_KEY
  NVIDIA_KEY="${NVIDIA_KEY# }"
  NVIDIA_KEY="${NVIDIA_KEY% }"
  if [ -n "$NVIDIA_KEY" ] && [ "$NVIDIA_KEY" != "skip" ]; then
    if [ "$first" = false ]; then auth+=","; fi
    auth+='"nvidia": {"type": "api", "key": "'"$NVIDIA_KEY"'"}'
    first=false
  fi

  # OpenRouter
  echo ""
  echo "--- OpenRouter ---"
  echo "  Access many models (Claude, GPT, Gemini, etc.). Get key at: https://openrouter.ai/keys"
  read -rp "OpenRouter API Key (or skip): " OPENROUTER_KEY
  OPENROUTER_KEY="${OPENROUTER_KEY# }"
  OPENROUTER_KEY="${OPENROUTER_KEY% }"
  if [ -n "$OPENROUTER_KEY" ] && [ "$OPENROUTER_KEY" != "skip" ]; then
    if [ "$first" = false ]; then auth+=","; fi
    auth+='"openrouter": {"type": "api", "key": "'"$OPENROUTER_KEY"'"}'
    first=false
  fi

  # Groq
  echo ""
  echo "--- Groq ---"
  echo "  Fast inference for Llama, Mixtral, etc. Get key at: https://console.groq.com/keys"
  read -rp "Groq API Key (or skip): " GROQ_KEY
  GROQ_KEY="${GROQ_KEY# }"
  GROQ_KEY="${GROQ_KEY% }"
  if [ -n "$GROQ_KEY" ] && [ "$GROQ_KEY" != "skip" ]; then
    if [ "$first" = false ]; then auth+=","; fi
    auth+='"groq": {"type": "api", "key": "'"$GROQ_KEY"'"}'
    first=false
  fi

  # Ollama Cloud
  echo ""
  echo "--- Ollama Cloud ---"
  echo "  Hosted Ollama models. Get key at: https://cloud.ollama.com/"
  read -rp "Ollama Cloud API Key (or skip): " OLLAMA_KEY
  OLLAMA_KEY="${OLLAMA_KEY# }"
  OLLAMA_KEY="${OLLAMA_KEY% }"
  if [ -n "$OLLAMA_KEY" ] && [ "$OLLAMA_KEY" != "skip" ]; then
    if [ "$first" = false ]; then auth+=","; fi
    auth+='"ollama-cloud": {"type": "api", "key": "'"$OLLAMA_KEY"'"}'
    first=false
  fi

  # Cloudflare Workers AI (needs account ID too)
  echo ""
  echo "--- Cloudflare Workers AI ---"
  echo "  Run models on Cloudflare's network. Get key at: https://developers.cloudflare.com/workers-ai/"
  read -rp "Cloudflare API Key (or skip): " CF_KEY
  CF_KEY="${CF_KEY# }"
  CF_KEY="${CF_KEY% }"
  if [ -n "$CF_KEY" ] && [ "$CF_KEY" != "skip" ]; then
    read -rp "Cloudflare Account ID: " CF_ACCOUNT
    CF_ACCOUNT="${CF_ACCOUNT# }"
    CF_ACCOUNT="${CF_ACCOUNT% }"
    if [ "$first" = false ]; then auth+=","; fi
    auth+='"cloudflare-workers-ai": {"type": "api", "key": "'"$CF_KEY"'", "metadata": {"accountId": "'"$CF_ACCOUNT"'"}}'
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
    # Merge: take existing object, overlay new keys
    # Use jq if available, otherwise do a simple approach
    if command -v jq &>/dev/null; then
      echo "$EXISTING_AUTH" | jq --argjson new "$NEW_AUTH" '. + $new' > "$AUTH_FILE"
    else
      # Fallback: just overwrite (merge via jq only)
      echo "$NEW_AUTH" > "$AUTH_FILE"
      echo "  (install jq for proper merge; fell back to overwrite)"
    fi
    echo "✓ auth.json updated."
    ;;
  *)
    NEW_AUTH=$(build_auth)
    echo "$NEW_AUTH" > "$AUTH_FILE"
    echo "✓ API keys saved to $AUTH_FILE"
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
echo "Next steps:"
echo "  1. Restart opencode to apply changes"
echo "  2. If you skipped Google/GitHub Copilot auth, run:"
echo "       opencode auth login google"
echo "       opencode auth login github-copilot"
echo "  3. Verify your setup:"
echo "       opencode doctor"
echo ""
echo "Happy coding!"
