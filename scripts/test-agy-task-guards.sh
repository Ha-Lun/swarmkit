#!/usr/bin/env bash
# Tests for the opencode-task guards: effort per model, circuit breaker, global cap, dispatch log.
# A stub `opencode` on PATH emits the JSON-lines shape of `opencode run --format json` (no quota spent).
set -euo pipefail
TASK="$(cd "$(dirname "$0")" && pwd)/opencode-task"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export OPENCODE_TASK_DIR="$T/oc" AGY_TASK_DIR="$T/agy" PATH="$T/bin:$PATH" STUB_ARGS="$T/args"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mkdir -p "$T/bin"
# STUB_MODE: ok (default) | deny (12 permission errors, then hangs) | slow (sleeps STUB_SLEEP s first)
cat > "$T/bin/opencode" <<'S'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_ARGS"
echo stub > stub.txt
case "${STUB_MODE:-ok}" in
  deny) i=0
    while [ $i -lt 12 ]; do
      printf '{"type":"tool_use","sessionID":"ses_1","part":{"tool":"shell","state":{"status":"error","input":{"command":"cat > /secret/x <<EOF"},"error":"Permission denied: shell"}}}\n'
      i=$((i+1))
    done
    sleep 60 ;;
  slow) sleep "${STUB_SLEEP:-4}" ;;
esac
printf '{"type":"text","sessionID":"ses_1","part":{"text":"all done PROMPT-SECRET"}}\n'
printf '{"type":"step_finish","sessionID":"ses_1","part":{"tokens":{"input":10,"output":5,"reasoning":1,"cache":{"read":100,"write":0}}}}\n'
S
chmod +x "$T/bin/opencode"
fail() { echo "FAIL: $*"; exit 1; }
mkrepo() { git init -q "$T/$1" && git -C "$T/$1" commit -q --allow-empty -m one; }
last_model() { tail -1 "$STUB_ARGS" | sed -n 's/.* -m \([^ ]*\) .*/\1/p'; }
res() { jq -r "$2" "$OPENCODE_TASK_DIR"/$1-*/"$3"/result.json; }

mkrepo r1; cd "$T/r1"

# --- effort per model
D=opencode-go/cat-jam-free
"$TASK" start e1 "p" >/dev/null 2>&1 || true
[ "$(last_model)" = "$D#max" ] || fail "default model should get #max, got $(last_model)"
"$TASK" start e2 --model opencode-go/other "p" >/dev/null 2>&1 || true
[ "$(last_model)" = "opencode-go/other" ] || fail "unknown model should get no effort, got $(last_model)"
"$TASK" start e3 --model "$D" --effort "" "p" >/dev/null 2>&1 || true
[ "$(last_model)" = "$D" ] || fail "empty --effort should mean none, got $(last_model)"
"$TASK" start e4 --model opencode-go/other --effort high "p" >/dev/null 2>&1 || true
[ "$(last_model)" = "opencode-go/other#high" ] || fail "explicit effort ignored, got $(last_model)"
"$TASK" resume e1 --effort "" "again" >/dev/null 2>&1 || true
[ "$(last_model)" = "$D#max" ] || fail "resume must keep start's effort, got $(last_model)"
"$TASK" resume e2 --effort max "again" >/dev/null 2>&1 || true
[ "$(last_model)" = "opencode-go/other" ] || fail "resume must keep start's (empty) effort, got $(last_model)"
for s in e1 e2 e3 e4; do "$TASK" clean $s --force; done
echo "ok"
