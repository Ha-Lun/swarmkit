#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
sep="  $(printf '\033[38;5;240m·\033[0m')  "

# --- 1. Git branch ---
git_segment=""
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
if git -C "$cwd" rev-parse --git-dir > /dev/null 2>&1; then
  branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null)

  unstaged=$(git -C "$cwd" diff --no-ext-diff --quiet 2>/dev/null || echo "dirty")
  staged=$(git -C "$cwd" diff --cached --no-ext-diff --quiet 2>/dev/null || echo "staged")

  dirty=""
  [ "$staged" = "staged" ]   && dirty="${dirty}+"
  [ "$unstaged" = "dirty" ] && dirty="${dirty}*"

  if [ -n "$dirty" ]; then
    dirty=" $(printf '\033[38;5;208m')${dirty}$(printf '\033[0m')"
  else
    dirty=""
  fi

  git_segment="$(printf '\033[38;5;45m')$(printf '%s' "$branch")$(printf '\033[0m')${dirty}"
fi

# --- 2. Model display name ---
model=$(echo "$input" | jq -r '.model.display_name')
model_segment="$(printf '\033[38;5;75m')$(printf '%s' "$model")$(printf '\033[0m')"

# --- 3. Context usage ---
context_segment=""
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
if [ -n "$used_pct" ]; then
  used_int=$(printf '%.0f' "$used_pct")
  if (( used_int >= 80 )); then
    color=196
  elif (( used_int >= 50 )); then
    color=220
  else
    color=82
  fi
  context_segment="$(printf '\033[38;5;%dm' "$color")${used_pct}%$(printf '\033[0m')"
fi

# --- Assemble ---
output=""
[ -n "$git_segment" ]   && output="$git_segment"
[ -n "$model_segment" ] && { [ -n "$output" ] && output="$output$sep$model_segment" || output="$model_segment"; }
[ -n "$context_segment" ] && { [ -n "$output" ] && output="$output$sep$context_segment" || output="$context_segment"; }

echo "$output"