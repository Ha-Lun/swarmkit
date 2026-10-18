#!/usr/bin/env bash
# Tests for the opencode-task guards: effort per model, circuit breaker, global cap, start banner, list, dispatch log.
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
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$STUB_ARGS.cfg"
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
D=opencode-go/muse-spark-1.3-contributor
"$TASK" start e1 "p" >/dev/null 2>&1 || true
[ "$(last_model)" = "$D" ] || fail "default model should get no effort suffix, got $(last_model)"
"$TASK" start e2 --model opencode-go/glm-5.3-flash "p" >/dev/null 2>&1 || true
[ "$(last_model)" = "opencode-go/glm-5.3-flash" ] || fail "unknown model should get no effort, got $(last_model)"
"$TASK" start e3 --model "$D" --effort "" "p" >/dev/null 2>&1 || true
[ "$(last_model)" = "$D" ] || fail "empty --effort should mean none, got $(last_model)"
"$TASK" start e4 --model opencode-go/glm-5.3-flash --effort high "p" >/dev/null 2>&1 || true
[ "$(last_model)" = "opencode-go/glm-5.3-flash#high" ] || fail "explicit effort ignored, got $(last_model)"
"$TASK" resume e1 --effort high "again" >/dev/null 2>&1 || true
[ "$(last_model)" = "$D" ] || fail "resume must keep start's (empty) effort, got $(last_model)"
"$TASK" resume e2 --effort max "again" >/dev/null 2>&1 || true
[ "$(last_model)" = "opencode-go/glm-5.3-flash" ] || fail "resume must keep start's (empty) effort, got $(last_model)"
for s in e1 e2 e3 e4; do "$TASK" clean $s --force; done

# --- worker shell: test files in a subdirectory are allowed, node -e is not (only the default deny covers it)
"$TASK" start rg1 "p" >/dev/null 2>&1 || true
[ "$(jq -r '.permission.bash["node site/test/*"]' "$STUB_ARGS.cfg")" = allow ] || fail "node site/test/* not allowed"
# fixed prefixes only: a leading wildcard would also match node -e
[ "$(jq -r '[.permission.bash | to_entries[] | select(.value == "allow") | .key | select(startswith("node *") or contains("-e"))] | length' "$STUB_ARGS.cfg")" = 0 ] \
  || fail "an allow key starts with 'node *' or contains -e"
[ "$(jq -r '.permission.bash["node *"] // "none"' "$STUB_ARGS.cfg")" = none ] || fail "node * must not be allowed"
[ "$(jq -r '.permission.bash["node -e *"] // "none"' "$STUB_ARGS.cfg")" = none ] || fail "node -e * must not be allowed"
"$TASK" clean rg1 --force

# --- edit scope: no file tool outside the worktree, also with --yolo
"$TASK" start sc1 "p" >/dev/null 2>&1 || true
[ "$(jq -r .permission.external_directory "$STUB_ARGS.cfg")" = deny ] || fail "external_directory not denied"
"$TASK" start sc2 --yolo "p" >/dev/null 2>&1 || true
[ "$(jq -r .permission.external_directory "$STUB_ARGS.cfg")" = deny ] || fail "--yolo lifted external_directory"
for s in sc1 sc2; do "$TASK" clean $s --force; done

# --- start banner on stderr, live list (model, elapsed, live denied count), finished list
err=$("$TASK" start bn1 --effort high "PROMPT-SECRET" 2>&1 >/dev/null) || true
echo "$err" | grep -q "^opencode-task ▶ bn1 · model $D · effort high · base $(git rev-parse --short HEAD) · log .*/bn1/opencode.log" \
  || fail "start banner: $err"
echo "$err" | grep -q PROMPT-SECRET && fail "banner leaks the prompt"
err=$("$TASK" start bn2 "p" 2>&1 >/dev/null) || true
echo "$err" | grep -q "· effort none ·" || fail "empty effort should print none: $err"
err=$("$TASK" resume bn2 "again" 2>&1 >/dev/null) || true
echo "$err" | grep -q "▶ bn2 · model $D · effort none .* · resume" || fail "resume banner: $err"
"$TASK" list | grep -q "^bn1 .*muse-spark-1.3-contributor .*[0-9]s " || fail "list lacks model/wall: $("$TASK" list)"
[ "$("$TASK" list | wc -l)" = 2 ] || fail "list is not one line per task"
STUB_MODE=slow STUB_SLEEP=6 "$TASK" start bn3 --max-denied 0 "p" >/dev/null 2>&1 &
sleep 3
"$TASK" list | grep -Eq "^bn3 +running +muse-spark-1.3-contributor +0m0[0-9]s denied 0 " || fail "running list line: $("$TASK" list | grep bn3)"
wait
for s in bn1 bn2 bn3; do "$TASK" clean $s --force; done
# live denied count: the deny stub hangs after 12 denied calls; with the breaker off the log shows them while it runs
STUB_MODE=deny "$TASK" start bn4 --max-denied 0 --max-tool-errors 0 --timeout 8 "p" >/dev/null 2>&1 &
sleep 4
"$TASK" list | grep -Eq "^bn4 +running .* denied 12 " || fail "live denied count: $("$TASK" list | grep bn4)"
wait
"$TASK" clean bn4 --force
# queueing prints once, then the banner when the slot frees
export OPENCODE_TASK_MAX=1 STUB_MODE=slow STUB_SLEEP=3
"$TASK" start q1 "p" >/dev/null 2>&1 &
sleep 1
err=$("$TASK" start q2 --wait "p" 2>&1 >/dev/null) || true
wait
[ "$(echo "$err" | grep -c 'q2 · queued (1 running)')" = 1 ] || fail "queued line: $err"
echo "$err" | grep -q "▶ q2 · model" || fail "no banner after the queue: $err"
for s in q1 q2; do "$TASK" clean $s --force; done
unset OPENCODE_TASK_MAX STUB_MODE STUB_SLEEP

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

# --- global cap: two repos, cap 2, three starts; the third queues behind the other repo's task
mkrepo r2
export OPENCODE_TASK_MAX=2 STUB_MODE=slow STUB_SLEEP=5
(cd "$T/r1" && "$TASK" start cap1 "p" >/dev/null 2>&1) &
(cd "$T/r2" && "$TASK" start cap2 "p" >/dev/null 2>&1) &
sleep 2
cd "$T/r1"
out=$("$TASK" start cap3 "p" 2>&1) && fail "a third task started past the cap across repos"
echo "$out" | grep -q "2 delegated tasks already running" || fail "unexpected refusal: $out"
[ ! -e "$OPENCODE_TASK_DIR"/r1-*/cap3 ] || fail "refused task left a dir"
"$TASK" start cap3 --wait "p" >/dev/null 2>&1 &
sleep 2
[ ! -e "$OPENCODE_TASK_DIR"/r1-*/cap3 ] || fail "--wait task did not queue"
wait
[ "$(res r1 .ok cap3)" = true ] || fail "queued task did not run after a slot freed"
for s in cap1 cap3; do (cd "$T/r1" && "$TASK" clean $s --force); done
(cd "$T/r2" && "$TASK" clean cap2 --force)
unset OPENCODE_TASK_MAX STUB_MODE STUB_SLEEP

# --- worker model allowlist
AGY_TASK="${TASK%/*}/agy-task"
rc=0; out=$("$AGY_TASK" start no_claude_agy --model claude-sonnet-4-6 "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "agy-task allowlist guard exit code: $rc"
echo "$out" | grep -q "^agy-task: model not on the worker allowlist: claude-sonnet-4-6" \
  || fail "agy-task allowlist guard message: $out"
[ ! -e "$AGY_TASK_DIR"/*/no_claude_agy ] || fail "agy-task allowlist guard left a task dir"

rc=0; out=$("$TASK" start no_claude_oc --model opencode-go/claude-haiku-5-5 "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "opencode-task allowlist guard exit code: $rc"
echo "$out" | grep -q "^opencode-task: model not on the worker allowlist: opencode-go/claude-haiku-5-5" \
  || fail "opencode-task allowlist guard message: $out"
[ ! -e "$OPENCODE_TASK_DIR"/*/no_claude_oc ] || fail "opencode-task allowlist guard left a task dir"

rc=0; out=$("$TASK" start no_kimi_oc --model opencode-go/kimi-k2.7-code "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "opencode-task allowlist guard exit code for kimi: $rc"
[ ! -e "$OPENCODE_TASK_DIR"/*/no_kimi_oc ] || fail "opencode-task allowlist guard left a task dir"

# --- dispatch log: allowlisted fields only
export SWARMKIT_DISPATCH_LOG="$T/dispatch.jsonl"
"$TASK" start dl1 "PROMPT-SECRET please" >/dev/null 2>&1 || true
STUB_MODE=deny "$TASK" start dl2 "p" >/dev/null 2>&1 || true
[ "$(wc -l < "$SWARMKIT_DISPATCH_LOG")" = 4 ] || fail "expected a start and a finish line per task"
jq -es '[.[] | select(.event == "start")] | length == 2 and all(.[]; keys == ["cli","effort","event","model","slug","ts"])' "$SWARMKIT_DISPATCH_LOG" >/dev/null \
  || fail "start lines not the allowlist"
jq -es '[.[] | select(.event == "finish")] | length == 2 and all(.[]; keys == ["cli","denied","event","model","ok","slug","stopped_by","tokens","ts","wall_s"])' "$SWARMKIT_DISPATCH_LOG" >/dev/null \
  || fail "finish lines not the allowlist"
jq -es '.[0] | .event == "start" and .cli == "opencode" and .slug == "dl1" and .model == "'"$D"'" and .effort == null' "$SWARMKIT_DISPATCH_LOG" >/dev/null \
  || fail "start log line: $(head -1 "$SWARMKIT_DISPATCH_LOG")"
jq -es '[.[] | select(.event == "finish")] | .[0] | .cli == "opencode" and .slug == "dl1" and .model == "'"$D"'" and .denied == 0 and .tokens == 116 and .stopped_by == null
        and (.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$")) and (.wall_s | type == "number")' "$SWARMKIT_DISPATCH_LOG" >/dev/null \
  || fail "first finish line"
jq -es '[.[] | select(.event == "finish")] | .[1] | .ok == false and .slug == "dl2" and .denied >= 10 and .stopped_by == "max-denied"' "$SWARMKIT_DISPATCH_LOG" >/dev/null \
  || fail "second finish line: $(tail -1 "$SWARMKIT_DISPATCH_LOG")"
grep -Eq "PROMPT-SECRET|$T|/secret|cat >" "$SWARMKIT_DISPATCH_LOG" && fail "log leaks a prompt, path or command"
unset SWARMKIT_DISPATCH_LOG
"$TASK" start dl3 "p" >/dev/null 2>&1 || true
[ "$(wc -l < "$T/dispatch.jsonl")" = 4 ] || fail "logged without SWARMKIT_DISPATCH_LOG"
for s in dl1 dl2 dl3; do "$TASK" clean $s --force; done
echo "ok"
