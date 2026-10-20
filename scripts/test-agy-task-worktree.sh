#!/usr/bin/env bash
# Regression test: opencode-task run from a linked git worktree branches from, and checks merges
# against, that worktree's HEAD, while task dirs stay keyed by the main checkout. A stub `opencode`
# on PATH stands in for the real CLI (no quota spent).
set -euo pipefail
TASK="$(cd "$(dirname "$0")" && pwd)/opencode-task"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export OPENCODE_TASK_DIR="$T/oc" AGY_TASK_DIR="$T/agy" PATH="$T/bin:$PATH"
export SWARMKIT_ALLOW_WORKERS=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mkdir -p "$T/bin" && printf '#!/bin/sh\necho stub > stub.txt\n' > "$T/bin/opencode" && chmod +x "$T/bin/opencode"
fail() { echo "FAIL: $*"; exit 1; }

git init -q "$T/main" && cd "$T/main" && git commit -q --allow-empty -m one
git worktree add -q -b side "$T/side" && cd "$T/side" && git commit -q --allow-empty -m two
side_head=$(git rev-parse HEAD)

"$TASK" start w1 "stub" >/dev/null 2>&1 || true   # the stub gives no result, so NOT ok is expected
dir=$(ls -d "$OPENCODE_TASK_DIR"/main-*/w1) || fail "task dir not keyed by the main checkout"
[ "$(cat "$dir/base")" = "$side_head" ] || fail "base is not the linked worktree's HEAD"
[ "$(git -C "$dir/worktree" rev-parse HEAD~1)" = "$side_head" ] || fail "worker branch not on top of side"
"$TASK" clean w1 >/dev/null 2>&1 && fail "clean accepted an unmerged branch"
git merge -q --ff-only opencode/w1
"$TASK" clean w1 || fail "clean refused a branch merged into the linked worktree's HEAD"

cd "$T/main"   # unchanged behaviour from the main checkout
"$TASK" start w2 "stub" >/dev/null 2>&1 || true
[ "$(cat "$OPENCODE_TASK_DIR"/main-*/w2/base)" = "$(git rev-parse HEAD)" ] || fail "main checkout base changed"
"$TASK" clean w2 >/dev/null 2>&1 && fail "clean accepted an unmerged branch from main"
"$TASK" clean w2 --force
echo "ok"
