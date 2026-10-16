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

# --- circuit breaker: the stub sends 12 denied calls, then hangs for 60 s
t0=$SECONDS
STUB_MODE=deny "$TASK" start cb1 "p" >/dev/null 2>&1 && fail "a stopped worker reported success"
[ $((SECONDS - t0)) -lt 30 ] || fail "breaker did not kill the hanging worker"
[ "$(res r1 .ok cb1)" = false ] || fail "stopped worker should be ok:false"
[ "$(res r1 .stopped_by cb1)" = max-denied ] || fail "stopped_by: $(res r1 .stopped_by cb1)"
[ "$(res r1 '.denied_actions|length' cb1)" -ge 10 ] || fail "result lost the denied actions"
res r1 '.warnings[]' cb1 | grep -q "^stopped: 10 denied commands" || fail "no stopped warning"
[ "$(res r1 .changes cb1)" != "no changes" ] || fail "the stopped worker's edits were not committed"
git -C "$OPENCODE_TASK_DIR"/r1-*/cb1/worktree log --oneline -1 | grep -q "opencode: cb1" || fail "no final commit"
"$TASK" clean cb1 --force
# own limits: 3 denied allowed to stop earlier; 0 turns the breaker off (stub then hangs, so cap it with a timeout)
STUB_MODE=deny "$TASK" start cb2 --max-denied 3 "p" >/dev/null 2>&1 || true
res r1 '.warnings[]' cb2 | grep -q "^stopped: 3 denied commands" || fail "--max-denied 3 ignored"
"$TASK" clean cb2 --force
STUB_MODE=deny "$TASK" start cb3 --max-denied 0 --max-tool-errors 5 "p" >/dev/null 2>&1 || true
[ "$(res r1 .stopped_by cb3)" = max-tool-errors ] || fail "--max-tool-errors ignored: $(res r1 .stopped_by cb3)"
res r1 '.warnings[]' cb3 | grep -q "^stopped: 5 failed tool calls" || fail "no max-tool-errors warning"
"$TASK" clean cb3 --force
STUB_MODE=deny "$TASK" start cb4 --max-denied 0 --max-tool-errors 0 --timeout 3 "p" >/dev/null 2>&1 || true
[ "$(res r1 .stopped_by cb4)" = timeout ] || fail "breaker off should leave the timeout: $(res r1 .stopped_by cb4)"
[ "$(res r1 '.denied_actions|length' cb4)" = 12 ] || fail "partial output lost on timeout"
"$TASK" clean cb4 --force
echo "ok"
