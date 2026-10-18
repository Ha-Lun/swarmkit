#!/usr/bin/env bash
# SwarmKit Unified Installer
# Usage: ./install.sh [options]
# Options:
#   --opencode    Install OpenCode config
#   --agy         Install Antigravity (agy) Swarm config
#   --claude      Install Claude Code Swarm config (also installs the swarm pack
#                 orchestrators + coordination agents globally)
#   --n8n         Configure local self-hosted n8n credentials (optional add-on, not in --all)
#   --cloudflare  Install Cloudflare skills and configure auth (optional add-on, not in --all)
#   --all         Install all agent configs (opencode, agy, claude)
#   --free        Enable free mode for OpenCode (uses default models, no keys)
#   --mcp         Install the MCP servers from core/mcp.json (Claude Code, agy, OpenCode).
#                 Off by default: a terminal run asks once, other runs skip them
#   --alias       Add shell aliases to ~/.bashrc (and ~/.zshrc if it exists) so plain `claude` /
#                 `agy` start lead-dev-hybrid. Hybrid profile only; off by default: a terminal
#                 run asks once, other runs skip it. --slim and --uninstall remove them
#   --hybrid      Force the hybrid profile (lead-dev-hybrid orchestrator + worker lanes)
#   --slim        Force the slim profile (no orchestrator; the main agent works directly)
#   (no flags)    Install the CLIs found on PATH and pick a profile: hybrid when opencode
#                 is found or claude + agy are, else slim. Prints the choice at the end
#   --pack <name> [project]  Link a Claude Code specialist pack (agents + skills)
#                 into <project>/.claude/ (default: current dir) and hide the links
#                 via .git/info/exclude. Packs: web ops mobile n8n backend creative swarm.
#                 The swarm pack is also installed globally by --claude, so per-project
#                 --pack swarm is optional
#   --uninstall   Uninstall all configurations (with --pack: remove only that pack
#                 from the project)
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
MCP=false         # --mcp, or a yes at the prompt
ALIAS=false       # --alias, or a yes at the prompt
PROFILE=""        # hybrid | slim; --hybrid/--slim, else picked from the CLIs found
UNINSTALL_MODE=false
PACK=""
PACK_DIR="$PWD"

# Parse arguments
while [ $# -gt 0 ]; do
  arg="$1"; shift
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
    --mcp)      MCP=true ;;
    --alias)    ALIAS=true ;;
    --hybrid)   PROFILE=hybrid ;;
    --slim)     PROFILE=slim ;;
    --uninstall)UNINSTALL_MODE=true ;;
    --pack)
      [ $# -gt 0 ] || { echo "--pack needs a pack name"; exit 1; }
      PACK="$1"; shift
      if [ $# -gt 0 ] && [[ "$1" != --* ]]; then PACK_DIR="$1"; shift; fi
      ;;
    --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      exit 1
      ;;
  esac
done

OPENCODE_DIR="$HOME/.config/opencode"
GEMINI_DIR="$HOME/.gemini/config"
CLAUDE_DIR="$HOME/.claude"
# Legacy: the Codex target was removed (see CHANGELOG.md). These stay only so
# --uninstall still removes links left by an old --codex install.
LEGACY_CODEX_DIR="$HOME/.codex"
LEGACY_AGENTS_SKILLS_DIR="$HOME/.agents/skills"

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

# Put the marked alias block $2 (empty = remove it) into rc file $1: an existing block is replaced in
# place, else it is appended. Returns 0 only if the file changed (backed up first); a rerun is a no-op.
ALIAS_BEGIN="# >>> swarmkit aliases >>>"
ALIAS_END="# <<< swarmkit aliases <<<"
alias_rc() {
  local rc="$1" block="$2" src=/dev/null tmp
  if [ -f "$rc" ]; then
    src="$rc"
    if grep -qxF "$ALIAS_BEGIN" "$rc" && ! grep -qxF "$ALIAS_END" "$rc"; then
      echo "  ! $rc has a swarmkit alias start marker without its end marker; left alone"
      return 1
    fi
  elif [ -z "$block" ]; then
    return 1
  fi
  tmp="$(mktemp)"
  BLK="$block" awk -v b="$ALIAS_BEGIN" -v e="$ALIAS_END" '
    $0 == b { if (!done && ENVIRON["BLK"] != "") print ENVIRON["BLK"]; done = 1; skip = 1; next }
    skip    { if ($0 == e) skip = 0; next }
    { print }
    END { if (!done && ENVIRON["BLK"] != "") { if (NR > 0) print ""; print ENVIRON["BLK"] } }
  ' "$src" > "$tmp"
  if cmp -s "$tmp" "$src"; then rm -f "$tmp"; return 1; fi
  backup_if_exists "$rc"
  cat "$tmp" > "$rc"; rm -f "$tmp"
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

# Symlink each file of $1 into the real directory $2, so files you add there stay yours (and a build
# can't delete them). An old whole-directory link into this repo is replaced; a name that is already
# a file of yours is skipped.
link_files() {
  local src_dir="$1" dest="$2" f name
  if [ -L "$dest" ] && [[ "$(readlink "$dest")" == "$REPO_DIR"/* ]]; then rm -f "$dest"; fi
  mkdir -p "$dest"
  prune_dead_repo_links "$dest"
  for f in "$src_dir"/*; do
    [ -e "$f" ] || continue  # an empty source directory leaves the glob unexpanded
    name="$(basename "$f")"
    if { [ -e "$dest/$name" ] || [ -L "$dest/$name" ]; } && [[ "$(readlink "$dest/$name" 2>/dev/null)" != "$REPO_DIR"/* ]]; then
      echo "  ! $dest/$name exists and is not a SwarmKit link; skipped"
      continue
    fi
    ln -sfn "$f" "$dest/$name"
  done
}

# Skills Claude Code gets globally; the rest come with a pack (--pack).
CLAUDE_SKILLS="release-testing security-review caveman caveman-commit caveman-compress
caveman-help caveman-review ponytail ponytail-audit ponytail-debt ponytail-help
ponytail-review curated-resources agy-delegate delegate-implementation hybrid-delegate
diagnosing-bugs swarm-handoff git-workflow writing-for-agents"

# Skills that ship with each Claude Code pack (agents come from claude/packs/<pack>/agents).
pack_skills() {
  case "$1" in
    web)      echo "frontend-quality premium-frontend-system seo-engineering seo-sharing-pass web-design-guidelines scroll-craft" ;;
    backend)  echo "backend-quality" ;;
    mobile)   echo "capacitor-mobile-quality" ;;
    n8n)      echo "n8n-api n8n-debugging" ;;
    creative) echo "showroom img2threejs" ;;
    swarm)    echo "swarm-handoff git-workflow writing-for-agents" ;;
    ops)      echo "" ;;
  esac
}

# Symlink shared skills into $1: all of them, or only the names in $2 (then any
# other link into this repo is removed, so the set stays exact).
link_skills() {
  local dest="$1" only="${2:-}" skill_dir name
  mkdir -p "$dest"
  if [ -n "$only" ]; then remove_repo_links "$dest"; else prune_dead_repo_links "$dest"; fi
  for skill_dir in "$REPO_DIR"/core/skills/*/; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    name="$(basename "$skill_dir")"
    if [ -n "$only" ] && [[ " $(echo $only) " != *" $name "* ]]; then continue; fi
    ln -sfn "${skill_dir%/}" "$dest/$name"
  done
}

# Link (or with --uninstall, unlink) a pack's agents and skills in a project's
# .claude/, and list the links in the repo's .git/info/exclude.
pack_cmd() {
  local pack="$1" proj mode="$2" src name dest rel top excl
  if [ ! -d "$REPO_DIR/claude/packs/$pack/agents" ]; then
    echo "Unknown pack: $pack (available: $(ls "$REPO_DIR/claude/packs" | tr '\n' ' '))"
    exit 1
  fi
  proj="$(cd "$PACK_DIR" && pwd -P)"
  top="$(git -C "$proj" rev-parse --show-toplevel 2>/dev/null || true)"
  excl="$(git -C "$proj" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null || true)"
  [ "$mode" = remove ] || mkdir -p "$proj/.claude/agents" "$proj/.claude/skills"
  for src in "$REPO_DIR/claude/packs/$pack/agents/"*.md \
             $(for name in $(pack_skills "$pack"); do echo "$REPO_DIR/core/skills/$name"; done); do
    name="$(basename "$src")"
    if [[ "$src" == */agents/* ]]; then dest="$proj/.claude/agents/$name"; else dest="$proj/.claude/skills/$name"; fi
    if [ -e "$dest" ] && [[ "$(readlink "$dest" 2>/dev/null)" != "$REPO_DIR"/* ]]; then
      echo "  ! $dest exists and is not a SwarmKit link; skipped"
      continue
    fi
    if [ "$mode" = remove ]; then rm -f "$dest"; else ln -sfn "$src" "$dest"; fi
    [ -n "$top" ] || continue
    rel="/$(realpath -s --relative-to="$top" "$dest")"
    mkdir -p "$(dirname "$excl")"; touch "$excl"
    if [ "$mode" = remove ]; then
      grep -vxF "$rel" "$excl" > "$excl.tmp" || true
      cat "$excl.tmp" > "$excl"; rm -f "$excl.tmp"
    elif ! grep -qxF "$rel" "$excl"; then
      echo "$rel" >> "$excl"
    fi
  done
  if [ "$mode" = remove ]; then
    rmdir "$proj/.claude/agents" "$proj/.claude/skills" "$proj/.claude" 2>/dev/null || true
    echo "✓ Removed pack '$pack' from $proj/.claude"
  else
    echo "✓ Linked pack '$pack' into $proj/.claude${top:+ (listed in $excl)}"
  fi
}

# Logo: only on an interactive terminal (nothing in logs or pipes); colours unless NO_COLOR is set.
banner() {
  [ -t 1 ] && [ "${TERM:-dumb}" != dumb ] || return 0
  local c="" b="" d="" r=""
  if [ -z "${NO_COLOR:-}" ]; then c=$'\033[38;5;214m' b=$'\033[1m' d=$'\033[2m' r=$'\033[0m'; fi
  echo ""
  printf '%s%s%s\n' "$c" '   __    __' "$r"
  printf '%s%s%s     %s%s%s\n' "$c" '  /  \__/  \' "$r" "$b" '█▀▀ █ █ █ ▄▀█ █▀█ █▀▄▀█ █▄▀ █ ▀█▀' "$r"
  printf '%s%s%s     %s%s%s\n' "$c" '  \__/  \__/' "$r" "$b" '▄▄█ ▀▄▀▄▀ █▀█ █▀▄ █ ▀ █ █ █ █  █' "$r"
  printf '%s%s%s     %sone config, three CLIs%s\n' "$c" '  /  \__/  \' "$r" "$d" "$r"
  printf '%s%s%s     %sClaude Code · OpenCode · Antigravity%s\n' "$c" '  \__/  \__/' "$r" "$d" "$r"
  echo ""
}

# Remove the old plan-gate UserPromptSubmit hook from ~/.claude/settings.json.
# Writes (after a backup) only when something changes, so re-runs are no-ops.
plan_gate_settings() {
  local settings="$CLAUDE_DIR/settings.json" tmp
  tmp="$(mktemp)"
  if python3 - "$settings" "$tmp" "$1" <<'PY'
import json, os, sys
path, out, mode = sys.argv[1:]
try:
    s = json.load(open(path)) if os.path.exists(path) else {}
except ValueError as e:
    sys.exit(f'  ! {path} is not valid JSON ({e}); plan-gate hook not changed')
hooks = s.get('hooks', {})
ups = hooks.get('UserPromptSubmit', [])
mine = lambda e: any('plan-gate.py' in h.get('command', '') for h in e.get('hooks', []))
kept = [e for e in ups if not mine(e)]
if len(kept) == len(ups):
    sys.exit(1)
if kept:
    hooks['UserPromptSubmit'] = kept
else:
    del hooks['UserPromptSubmit']
if not hooks:
    del s['hooks']
with open(out, 'w') as f:
    json.dump(s, f, indent=2, ensure_ascii=False)
    f.write('\n')
PY
  then
    backup_if_exists "$settings"
    cat "$tmp" > "$settings"
    echo "  settings.json: plan-gate hook ($1)"
  fi
  rm -f "$tmp"
}

if [ -n "$PACK" ]; then
  if [ "$UNINSTALL_MODE" = true ]; then pack_cmd "$PACK" remove; else pack_cmd "$PACK" add; fi
  exit 0
fi

banner

if [ "$UNINSTALL_MODE" = true ]; then
  echo "Uninstalling configurations..."
  for d in "$OPENCODE_DIR" "$OPENCODE_DIR/agents" "$OPENCODE_DIR/command" "$OPENCODE_DIR/skills" \
           "$CLAUDE_DIR" "$CLAUDE_DIR/agents" "$CLAUDE_DIR/skills" "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/workflows" \
           "$GEMINI_DIR/plugins" "$GEMINI_DIR/skills" "$HOME/.opencode" \
           "$LEGACY_CODEX_DIR" "$LEGACY_CODEX_DIR/agents" "$LEGACY_AGENTS_SKILLS_DIR"; do  # legacy --codex links
    remove_repo_links "$d"
  done
  plan_gate_settings remove
  # only links into this repo (our shims): ~/.local/bin also holds other tools' links
  remove_repo_links "$HOME/.local/bin"
  rm -f "$GEMINI_DIR/mcp_config.json"
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if alias_rc "$rc" ""; then echo "  removed swarmkit aliases from ${rc/#$HOME/\~}"; fi
  done
  echo "Uninstall complete. MCP servers registered with 'claude mcp' (or 'codex mcp' by an old --codex install) are left in place."
  exit 0
fi

install_opencode() {
  echo "=== Installing OpenCode Config ==="
  mkdir -p "$OPENCODE_DIR"

  # Old installs linked into ~/.opencode (OpenCode's install dir); drop those links.
  remove_repo_links "$HOME/.opencode"

  link_files "$REPO_DIR/opencode/agents" "$OPENCODE_DIR/agents"
  link "$REPO_DIR/opencode/AGENTS.md" "$OPENCODE_DIR/AGENTS.md"
  link_files "$REPO_DIR/opencode/command" "$OPENCODE_DIR/command"
  link_skills "$OPENCODE_DIR/skills"

  if [ "$FREE_MODE" = true ] || [ "$MCP" != true ]; then
    # A copy, not a link: free mode swaps the model, no --mcp drops the "mcp" block.
    local conf="$OPENCODE_DIR/opencode.jsonc" tmp
    tmp="$(mktemp)"
    if [ "$FREE_MODE" = true ]; then
      echo "Free mode: Creating customized opencode.jsonc without explicit models..."
      sed 's/"model": ".*"/"model": "opencode\/nemotron-3.5-lightning-free"/' "$REPO_DIR/opencode/opencode.jsonc" > "$tmp"
    else
      cp "$REPO_DIR/opencode/opencode.jsonc" "$tmp"
    fi
    if [ "$MCP" != true ]; then
      python3 -c 'import json,sys;d=json.load(sys.stdin);d.pop("mcp",None);json.dump(d,sys.stdout,indent=2,ensure_ascii=False);print()' < "$tmp" > "$tmp.new"
      mv "$tmp.new" "$tmp"
    fi
    if [ -L "$conf" ] || ! cmp -s "$tmp" "$conf"; then  # a re-run changes nothing
      if [[ "$(readlink "$conf" 2>/dev/null)" != "$REPO_DIR"/* ]]; then backup_if_exists "$conf"; fi
      rm -f "$conf"
      cp "$tmp" "$conf"
    fi
    rm -f "$tmp"
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
  if [ "$MCP" = true ] && ! cmp -s "$REPO_DIR/core/mcp.json" "$GEMINI_DIR/mcp_config.json"; then
    backup_if_exists "$GEMINI_DIR/mcp_config.json"
    cp "$REPO_DIR/core/mcp.json" "$GEMINI_DIR/mcp_config.json"
  fi

  # Install agyw account switcher (only if missing, so a re-run needs no network)
  if command -v npm &>/dev/null; then
    if command -v agyw &>/dev/null; then
      echo "agyw already installed"
    else
      echo "Installing agyw (account switcher)..."
      npm install -g agyw@0.2.1
    fi
    if [ -d "$HOME/.gemini/antigravity-cli" ]; then
      agyw init
      echo "✓ agyw installed and initialized"
    else
      echo "✓ agyw installed. Run 'agyw init' after launching agy for the first time."
    fi
  else
    echo "⚠ npm not found — skipping agyw. Install Node.js then run: npm install -g agyw@0.2.1 && agyw init"
  fi

  echo "✓ Antigravity (agy) installation complete"
}

install_claude() {
  echo "=== Installing Claude Code Config ==="
  mkdir -p "$CLAUDE_DIR/hooks"

  link "$REPO_DIR/claude/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
  link_files "$REPO_DIR/claude/agents" "$CLAUDE_DIR/agents"
  if [ "$PROFILE" = hybrid ]; then
    link_files "$REPO_DIR/claude/packs/swarm/agents" "$CLAUDE_DIR/agents"
  else  # slim: drop the orchestrator links an earlier hybrid install made
    local f l
    for f in "$REPO_DIR"/claude/packs/swarm/agents/*.md; do
      l="$CLAUDE_DIR/agents/$(basename "$f")"
      if [ -L "$l" ] && [[ "$(readlink "$l")" == "$REPO_DIR"/* ]]; then rm -f "$l"; fi
    done
  fi
  link "$REPO_DIR/claude/hooks/guard.py" "$CLAUDE_DIR/hooks/guard.py"
  # plan-gate.py was dropped; clean up its link and settings entry from old installs.
  prune_dead_repo_links "$CLAUDE_DIR/hooks"
  plan_gate_settings remove
  local skills="$CLAUDE_SKILLS"
  command -v opencode &>/dev/null && skills+=" opencode-delegate"  # only for CLIs that are installed
  if [ "$PROFILE" != hybrid ]; then  # the orchestration skills only matter with lead-dev-hybrid
    local s kept=""
    for s in $skills; do
      case " hybrid-delegate swarm-handoff git-workflow writing-for-agents " in *" $s "*) ;; *) kept+=" $s" ;; esac
    done
    skills="$kept"
  fi
  link_skills "$CLAUDE_DIR/skills" "$skills"
  mkdir -p "$HOME/.local/bin"
  link "$REPO_DIR/scripts/agy-task" "$HOME/.local/bin/agy-task"
  link "$REPO_DIR/scripts/opencode-task" "$HOME/.local/bin/opencode-task"
  prune_dead_repo_links "$HOME/.local/bin"  # shims dropped from the repo

  # MCP servers (only with --mcp): register each one at user scope unless it already exists.
  if [ "$MCP" != true ]; then
    :
  elif command -v claude &>/dev/null; then
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

# Which CLIs are on PATH; with no CLI flag, install exactly those.
FOUND=""
for cli in claude opencode agy; do command -v "$cli" &>/dev/null && FOUND+="$cli " || true; done
has() { [[ " $FOUND " == *" $1 "* ]]; }
if [ "$INSTALL_OPENCODE$INSTALL_AGY$INSTALL_CLAUDE$INSTALL_N8N$INSTALL_CLOUDFLARE" = falsefalsefalsefalsefalse ]; then
  if [ -z "$FOUND" ]; then
    echo "No claude, opencode or agy found on PATH. Install one, or name the target: ./install.sh --claude|--opencode|--agy|--all"
    exit 1
  fi
  has opencode && INSTALL_OPENCODE=true
  has agy      && INSTALL_AGY=true
  has claude   && INSTALL_CLAUDE=true
  echo "Found: $FOUND"
fi

# Profile: hybrid = lead-dev-hybrid orchestrates workers; slim = the main agent works directly.
if [ -z "$PROFILE" ]; then
  if has opencode || { has claude && has agy; }; then PROFILE=hybrid; else PROFILE=slim; fi
fi

# MCP servers are opt-in: --mcp, or one question on a terminal.
MCP_NAMES="$(python3 -c "import json;print(' '.join(json.load(open('$REPO_DIR/core/mcp.json'))['mcpServers']))")"
if [ "$MCP" != true ] && [ -t 0 ] && [ "$INSTALL_OPENCODE$INSTALL_AGY$INSTALL_CLAUDE" != falsefalsefalse ]; then
  read -r -p "Install MCP servers ($MCP_NAMES)? [y/N] " ans || ans=""
  [[ "$ans" =~ ^[Yy] ]] && MCP=true
fi

# Shell aliases (hybrid only) are opt-in too: --alias, or one question on a terminal.
ALIAS_LIST=""; ALIAS_LINES=""; ALIAS_NAMES=""
if [ "$PROFILE" = hybrid ]; then
  for cli in claude agy; do
    if has "$cli"; then
      ALIAS_LIST+="${ALIAS_LIST:+, }$cli='$cli --agent lead-dev-hybrid'"
      ALIAS_LINES+="alias $cli='$cli --agent lead-dev-hybrid'"$'\n'
      ALIAS_NAMES+="${ALIAS_NAMES:+, }$cli"
    fi
  done
fi
if [ "$ALIAS" != true ] && [ -t 0 ] && [ -n "$ALIAS_LIST" ]; then
  read -r -p "Add shell aliases ($ALIAS_LIST) to ~/.bashrc? [y/N] " ans || ans=""
  [[ "$ans" =~ ^[Yy] ]] && ALIAS=true
fi

if [ "$INSTALL_OPENCODE" = true ]; then install_opencode; fi
if [ "$INSTALL_AGY" = true ]; then install_agy; fi
if [ "$INSTALL_CLAUDE" = true ]; then install_claude; fi
if [ "$INSTALL_N8N" = true ]; then install_n8n; fi
if [ "$INSTALL_CLOUDFLARE" = true ]; then install_cloudflare; fi

alias_msg=""; alias_files="~/.bashrc"
if [ "$PROFILE" = slim ]; then
  removed=false
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do if alias_rc "$rc" ""; then removed=true; fi; done
  [ "$removed" = false ] || alias_msg="removed (slim)"
elif [ -n "$ALIAS_LIST" ]; then
  if [ "$ALIAS" = true ]; then
    block="$ALIAS_BEGIN"$'\n'"${ALIAS_LINES}$ALIAS_END"
    alias_rc "$HOME/.bashrc" "$block" || true
    [ ! -f "$HOME/.zshrc" ] || { alias_rc "$HOME/.zshrc" "$block" || true; alias_files+=", ~/.zshrc"; }
    alias_msg="added to $alias_files ($ALIAS_NAMES)"
  else
    alias_msg="skipped (rerun with --alias)"
  fi
fi

workers=""
[ "$PROFILE" = hybrid ] && { has opencode && workers+="opencode-task "; has agy && workers+="agy-task "; }
if [ "$PROFILE" = hybrid ]; then
  if has claude; then run="claude --agent lead-dev-hybrid"
  elif has opencode; then run="opencode  (lead-dev-hybrid is already the default agent)"
  else run="agy --agent lead-dev-hybrid"; fi
  profile_note="hybrid: lead-dev-hybrid plans and hands work to workers"
elif has claude; then
  run="claude"; profile_note="slim: the main agent works directly; add the orchestrator later with ./install.sh --hybrid"
else
  if has agy; then run="agy"; else run="opencode"; fi
  profile_note="slim: the main agent works directly; add the orchestrator later with ./install.sh --hybrid"
fi

echo ""
echo "========================================"
echo "  Installation Successful! 🐝"
echo "========================================"
echo "CLIs found:  ${FOUND:-none}"
echo "Profile:     $profile_note"
echo "Run:         $run"
[ -z "$workers" ] || echo "Workers:     $workers"
if [ "$MCP" = true ]; then
  echo "MCP servers: installed ($MCP_NAMES)"
else
  echo "MCP servers: skipped. Rerun with --mcp to install ($MCP_NAMES);"
  echo "             that also restores the opencode.jsonc link with its MCP block. Servers already registered stay."
fi
if [ -n "$alias_msg" ]; then
  echo "Aliases:     $alias_msg"
  [[ "$alias_msg" != added* ]] || echo "             'command claude' bypasses the alias; run 'source ~/.bashrc' or open a new shell."
fi
echo "Restart your terminal or tools for changes to take effect."
