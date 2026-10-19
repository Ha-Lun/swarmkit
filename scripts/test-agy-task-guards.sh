#!/usr/bin/env bash
# Tests for the opencode-task guards: effort per model, circuit breaker, global cap, start banner, list, dispatch log,
# git isolation (both lanes). Stub `opencode` and `agy` CLIs on PATH; the opencode one emits the JSON-lines shape of `opencode run --format json` (no quota spent).
set -euo pipefail
TASK="$(cd "$(dirname "$0")" && pwd)/opencode-task"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export OPENCODE_TASK_DIR="$T/oc" AGY_TASK_DIR="$T/agy" PATH="$T/bin:$PATH" STUB_ARGS="$T/args"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mkdir -p "$T/bin"
# STUB_MODE: ok (default) | deny (opencode: 12 permission errors, then hangs) | slow (opencode: sleeps STUB_SLEEP s first)
#   and on both lanes (bin/modes): tamper (points .git at the planted gitdir $STUB_PLANT) | tamperdir (replaces .git
#   with a copy of it) | symlink (.git -> $STUB_PLANT) | delete (removes .git) | nested (sub/.git -> $STUB_PLANT)
#   | gitmodules (writes .gitmodules) | meta (writes a file into $STUB_META, the main repo's info/)
#   | head (points this worktree's HEAD record at branch $STUB_HEAD) | fifo (sub/.git is a FIFO)
cat > "$T/bin/modes" <<'S'
case "${STUB_MODE:-ok}" in
  tamper) printf 'gitdir: %s\n' "$STUB_PLANT" > .git ;;
  tamperdir) rm .git && cp -r "$STUB_PLANT" .git ;;
  symlink) rm .git && ln -s "$STUB_PLANT" .git ;;
  delete) rm .git ;;
  nested) mkdir -p sub && printf 'gitdir: %s\n' "$STUB_PLANT" > sub/.git && echo a > sub/f && echo '* filter=evil' > sub/.gitattributes ;;
  gitmodules) printf '[submodule "x"]\n\tpath = x\n\turl = ../x\n' > .gitmodules ;;
  meta) echo planted > "$STUB_META/planted" ;;
  head) printf 'ref: refs/heads/%s\n' "$STUB_HEAD" > "$(sed 's/^gitdir: //' .git)/HEAD" ;;
  fifo) mkdir -p sub && mkfifo sub/.git ;;
esac
S
cat > "$T/bin/opencode" <<'S'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_ARGS"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$STUB_ARGS.cfg"
echo stub > stub.txt
. "$(dirname "$0")/modes"
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
cat > "$T/bin/agy" <<'S'
#!/bin/sh
echo stub > stub.txt
. "$(dirname "$0")/modes"
printf '{"status":"SUCCESS","conversation_id":"c1","response":"done"}\n'
S
chmod +x "$T/bin/agy"
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

# --- opencode --agent: named specialist without widening the sandbox
export SWARMKIT_OPENCODE_AGENTS_DIR="$T/agents"
mkdir -p "$SWARMKIT_OPENCODE_AGENTS_DIR"
echo "# frontend" > "$SWARMKIT_OPENCODE_AGENTS_DIR/frontend-specialist.md"
last_agent() { grep -o -- '--agent [^ ]*' "$STUB_ARGS" | tail -1 | cut -d' ' -f2; }
"$TASK" start ag1 --agent frontend-specialist "p" >/dev/null 2>&1 || true
[ "$(last_agent)" = "frontend-specialist" ] || fail "agent not passed to worker, got $(last_agent)"
[ "$(jq -r '.agent["frontend-specialist"].permission.bash["*"]' "$STUB_ARGS.cfg")" = deny ] \
  || fail "agent overlay must deny bash *: $(cat "$STUB_ARGS.cfg")"
"$TASK" resume ag1 "again" >/dev/null 2>&1 || true
[ "$(last_agent)" = "frontend-specialist" ] || fail "resume must keep --agent, got $(last_agent)"
rc=0; out=$("$TASK" start ag_bad --agent no-such-agent "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "unknown agent exit code: $rc"
echo "$out" | grep -q "^opencode-task: unknown OpenCode agent: no-such-agent" || fail "unknown agent message: $out"
[ ! -e "$OPENCODE_TASK_DIR"/*/ag_bad ] || fail "unknown agent left a task dir"
rc=0; out=$("$TASK" start ag_path --agent ../x "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "path agent exit code: $rc"
[ ! -e "$OPENCODE_TASK_DIR"/*/ag_path ] || fail "path agent left a task dir"
rc=0; out=$("$TASK" start ag_orch --agent lead-dev-hybrid "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "orchestrator agent exit code: $rc"
echo "$out" | grep -q "^opencode-task: orchestrators cannot run as workers: lead-dev-hybrid" || fail "orchestrator message: $out"
[ ! -e "$OPENCODE_TASK_DIR"/*/ag_orch ] || fail "orchestrator agent left a task dir"
rc=0; out=$("$AGY_TASK" start ag_agy --agent frontend-specialist "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "agy lane agent exit code: $rc"
echo "$out" | grep -q "^agy-task: --agent is not supported on the agy lane" || fail "agy lane message: $out"
[ ! -e "$AGY_TASK_DIR"/*/ag_agy ] || fail "agy lane agent left a task dir"
printf -- "---\npermission:\n  edit:\n    '*': allow\n    '.git/*': allow\n---\n" > "$SWARMKIT_OPENCODE_AGENTS_DIR/gitty.md"
rc=0; out=$("$TASK" start ag_git --agent gitty "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "agent with a .git edit rule exit code: $rc"
echo "$out" | grep -q "^opencode-task: agent gitty has an edit rule for .git" || fail "agent .git rule message: $out"
[ ! -e "$OPENCODE_TASK_DIR"/*/ag_git ] || fail "agent with a .git edit rule left a task dir"
printf -- "---\npermission:\n  edit: {'*': allow, '**': allow}\n---\n" > "$SWARMKIT_OPENCODE_AGENTS_DIR/broad.md"
rc=0; out=$("$TASK" start ag_broad --agent broad "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "agent with an inline ** edit rule exit code: $rc"
echo "$out" | grep -q "^opencode-task: agent broad has an edit rule for .git" || fail "inline ** rule message: $out"
"$TASK" start ag2 "p" >/dev/null 2>&1 || true
[ "$(last_agent)" = "build" ] || fail "default agent should be build, got $(last_agent)"
for s in ag1 ag2; do "$TASK" clean $s --force; done
unset SWARMKIT_OPENCODE_AGENTS_DIR

# --- git isolation: a worker that points .git at a gitdir it planted gets nothing run or committed there
AGY_RES="$AGY_TASK_DIR"
[ "$(jq -r '.permission.edit | to_entries | map(select(.value == "deny") | .key) | sort | join(" ")' "$STUB_ARGS.cfg")" \
  = "**/.git **/.git/* .git .git/*" ] || fail "overlay does not deny edits to .git: $(jq -c .permission.edit "$STUB_ARGS.cfg")"
[ "$(jq -r '.permission.edit | to_entries | first | "\(.key)=\(.value)"' "$STUB_ARGS.cfg")" = "*=allow" ] \
  || fail "the edit allow-all must come first (opencode: last match wins)"
# read-only git: --output, --no-index and --ext-diff are denied after the git allows (last match wins)
for k in "git * --output*" "git * --no-index*" "git * --ext-diff*"; do
  jq -e --arg k "$k" '.permission.bash | to_entries | (map(.key) | index($k)) as $d | $d != null and .[$d].value == "deny"
        and ([to_entries[] | select(.value.value == "allow" and (.value.key | startswith("git "))) | .key] | max < $d)' \
    "$STUB_ARGS.cfg" >/dev/null || fail "$k is not a deny after every git allow: $(jq -c .permission.bash "$STUB_ARGS.cfg")"
done
git init -q "$T/plant" && echo x > "$T/plant/f" && git -C "$T/plant" add f && git -C "$T/plant" commit -q -m planted
export STUB_PLANT="$T/plant/.git"   # a tracked file: a status run inside a repo using this gitdir must clean-filter it
mkdir -p "$STUB_PLANT/evil-hooks"
for h in pre-commit post-commit reference-transaction post-index-change; do
  printf '#!/bin/sh\ntouch "%s"\n' "$T/marker" > "$STUB_PLANT/evil-hooks/$h"; chmod +x "$STUB_PLANT/evil-hooks/$h"
done
git -C "$T/plant" config core.hooksPath "$STUB_PLANT/evil-hooks"
git -C "$T/plant" config filter.evil.clean "touch $T/marker; cat"
mkdir -p "$STUB_PLANT/info" && echo '* filter=evil' > "$STUB_PLANT/info/attributes"  # read from whichever GIT_DIR is used
git -C "$T/plant" config core.fsmonitor "touch $T/marker; false"   # set last: git -C plant now trips it
plant_head=$(git --git-dir="$STUB_PLANT" -c core.fsmonitor=false rev-parse HEAD)
main_refs=$(git for-each-ref --format='%(refname) %(objectname)' refs/heads)
nomark() { [ ! -e "$T/marker" ] || fail "$1: a planted command ran"; }
tampered() {  # LANE DIR SLUG [HEAD]: the result is NOT ok with the warning, .git is restored, nothing ran or was committed
  local d; d=$(ls -d "$2"/r1-*/"$3")
  nomark "$1 $3"
  [ "$(jq -r .ok "$d/result.json")" = false ] || fail "$1 $3: tampered run reported ok"
  jq -r '.warnings[]' "$d/result.json" | grep -q "^worker modified .git" || fail "$1 $3: no warning: $(jq -c .warnings "$d/result.json")"
  [ -f "$d/worktree/.git" ] && [ ! -L "$d/worktree/.git" ] && cmp -s "$d/worktree/.git" "$d/dotgit" || fail "$1 $3: .git not restored"
  [ "$(git -C "$d/worktree" rev-parse HEAD)" = "${4:-$(cat "$d/base")}" ] || fail "$1 $3: the run was committed"
  [ "$(git --git-dir="$STUB_PLANT" -c core.fsmonitor=false rev-parse HEAD)" = "$plant_head" ] || fail "$1 $3: committed into the planted gitdir"
  [ "$(git --git-dir="$STUB_PLANT" -c core.fsmonitor=false ls-files)" = f ] || fail "$1 $3: staged into the planted gitdir"
}
blocked() {  # LANE DIR SLUG WARNING-REGEX: NOT ok with that warning, nothing committed, nothing ran
  local d; d=$(ls -d "$2"/r1-*/"$3")
  nomark "$1 $3"
  [ "$(jq -r .ok "$d/result.json")" = false ] || fail "$1 $3: blocked run reported ok"
  jq -r '.warnings[]' "$d/result.json" | grep -q "$4" || fail "$1 $3: no '$4' warning: $(jq -c .warnings "$d/result.json")"
  [ "$(git -C "$d/worktree" rev-parse HEAD)" = "$(cat "$d/base")" ] || fail "$1 $3: the run was committed"
}
STUB_MODE=tamper "$TASK" start gi1 "p" >/dev/null 2>&1 && fail "opencode tampered start reported success"
tampered opencode "$OPENCODE_TASK_DIR" gi1
STUB_MODE=tamperdir "$TASK" start gi2 "p" >/dev/null 2>&1 || true
tampered opencode "$OPENCODE_TASK_DIR" gi2
"$TASK" start gi3 "p" >/dev/null 2>&1 || fail "untampered opencode run not ok"
gi3_head=$(git rev-parse opencode/gi3)
STUB_MODE=tamper "$TASK" resume gi3 "again" >/dev/null 2>&1 && fail "opencode tampered resume reported success"
tampered opencode "$OPENCODE_TASK_DIR" gi3 "$gi3_head"
STUB_MODE=symlink "$TASK" start gi8 "p" >/dev/null 2>&1 || true
tampered opencode "$OPENCODE_TASK_DIR" gi8
STUB_MODE=delete "$TASK" start gi9 "p" >/dev/null 2>&1 || true
tampered opencode "$OPENCODE_TASK_DIR" gi9
STUB_MODE=tamper "$AGY_TASK" start gi4 "p" >/dev/null 2>&1 && fail "agy tampered start reported success"
tampered agy "$AGY_RES" gi4
STUB_MODE=tamperdir "$AGY_TASK" start gi7 "p" >/dev/null 2>&1 || true
tampered agy "$AGY_RES" gi7
"$AGY_TASK" start gi5 "p" >/dev/null 2>&1 || fail "untampered agy run not ok"
STUB_MODE=tamper "$AGY_TASK" resume gi5 "again" >/dev/null 2>&1 && fail "agy tampered resume reported success"
tampered agy "$AGY_RES" gi5 "$(git rev-parse agy/gi5)"
[ "$(git rev-parse agy/gi5~1)" = "$(cat "$AGY_RES"/r1-*/gi5/base)" ] || fail "agy resume: unexpected commits"
[ "$(git for-each-ref --format='%(refname) %(objectname)' refs/heads | grep -v '^refs/heads/[a-z]*/gi')" = "$main_refs" ] \
  || fail "a main repo branch moved"
# pinning on its own: a late re-tamper after the run; clean's dirty check (no --force) runs git status before it
# compares .git, so only the pin keeps that status out of the planted gitdir (whose info/attributes filter f)
d3=$(ls -d "$OPENCODE_TASK_DIR"/r1-*/gi3)
printf 'gitdir: %s\n' "$STUB_PLANT" > "$d3/worktree/.git" && echo y > "$d3/worktree/f"
out=$("$TASK" clean gi3 2>&1) && fail "clean accepted a re-tampered .git"
nomark "late re-tamper clean"
echo "$out" | grep -Eq "was changed since the run|has uncommitted changes" || fail "re-tamper clean message: $out"
# M1: run from inside a task worktree (or a nested dir there): refused before any git call, which would
# otherwise follow the (here still re-tampered) .git
out=$(cd "$d3/worktree" && "$TASK" start m1 "p" 2>&1) && fail "start from inside a task worktree accepted"
nomark "start from inside a task worktree"
echo "$out" | grep -q "run opencode-task from the main checkout" || fail "inside-worktree message: $out"
cp "$d3/dotgit" "$d3/worktree/.git" && rm "$d3/worktree/f"
out=$(cd "$d3" && "$AGY_TASK" list 2>&1) && fail "agy list from inside a task dir accepted"
echo "$out" | grep -q "from the main checkout" || fail "inside-task-dir message: $out"
# M2: a nested repo blocks the commit. The base has a gitlink sub, so a status run without
# --ignore-submodules=all would recurse into sub/ and clean-filter the planted repo's tracked f.
withsub=$(git commit-tree -p HEAD -m sub "$(printf '160000 commit %s\tsub\n' "$plant_head" | git mktree)")
STUB_MODE=nested "$TASK" start gi6 --base "$withsub" "p" >/dev/null 2>&1 && fail "nested run reported success"
blocked opencode "$OPENCODE_TASK_DIR" gi6 "^worker created a nested .git at sub/.git"
out=$("$TASK" clean gi6 2>&1) && fail "clean accepted the nested task"
echo "$out" | grep -q "has uncommitted changes" || fail "nested clean message: $out"
nomark "nested clean"
STUB_MODE=gitmodules "$AGY_TASK" start gi11 "p" >/dev/null 2>&1 && fail "gitmodules run reported success"
blocked agy "$AGY_RES" gi11 "^worker changed .gitmodules"
"$TASK" start gi10 --setup "git init -q vendor/lib" "p" >/dev/null 2>&1 || fail "a nested repo made by --setup blocked the run"
# M3: the recorded gitdir, the dotgit snapshot and the worktree path are checked against the main repo.
# opts.json, dotgit and .git all re-pointed at the plant, consistently: only that check keeps git out of it.
d5=$(ls -d "$AGY_RES"/r1-*/gi5)
cp "$d5/opts.json" "$T/opts.bak"; cp "$d5/dotgit" "$T/dotgit.bak"
jq --arg g "$STUB_PLANT" '.gitdir = $g' "$T/opts.bak" > "$d5/opts.json"
printf 'gitdir: %s\n' "$STUB_PLANT" | tee "$d5/dotgit" > "$d5/worktree/.git"; echo y > "$d5/worktree/f"
out=$("$AGY_TASK" resume gi5 "again" 2>&1) && fail "resume accepted a tampered opts.json gitdir"
nomark "resume with a tampered gitdir"
echo "$out" | grep -q "is not an entry of" || fail "tampered gitdir resume message: $out"
out=$("$AGY_TASK" clean gi5 2>&1) && fail "clean accepted a tampered opts.json gitdir"
nomark "clean with a tampered gitdir"
echo "$out" | grep -q "is not an entry of" || fail "tampered gitdir clean message: $out"
cp "$T/opts.bak" "$d5/opts.json"; cp "$T/dotgit.bak" "$d5/dotgit"; cp "$T/dotgit.bak" "$d5/worktree/.git"; rm "$d5/worktree/f"
printf 'gitdir: %s\n' "$STUB_PLANT" > "$d5/dotgit"
out=$("$AGY_TASK" resume gi5 "again" 2>&1) && fail "resume accepted a tampered dotgit"
echo "$out" | grep -q "does not match the recorded gitdir" || fail "tampered dotgit message: $out"
cp "$T/dotgit.bak" "$d5/dotgit"
mv "$d5/worktree" "$d5/wt.real" && ln -s wt.real "$d5/worktree"
out=$("$AGY_TASK" resume gi5 "again" 2>&1) && fail "resume accepted a symlinked worktree"
echo "$out" | grep -q "is not a real directory" || fail "symlinked worktree message: $out"
rm "$d5/worktree" && mv "$d5/wt.real" "$d5/worktree"
nomark "M3 refusals"
export STUB_META; STUB_META="$(git rev-parse --path-format=absolute --git-common-dir)/info"; mkdir -p "$STUB_META"
STUB_MODE=meta "$TASK" start gi12 "p" >/dev/null 2>&1 && fail "metadata-changing run reported success"
blocked opencode "$OPENCODE_TASK_DIR" gi12 "^git metadata changed during the run"
[ "$(res r1 .changes gi12)" = "not inspected" ] || fail "metadata change: git still ran in the worktree"
rm "$STUB_META/planted"; unset STUB_META
# HEAD record pointed at the main branch (plain agy can write there by absolute path): our commit would land on it
main_branch=$(git symbolic-ref --short HEAD); main_head=$(git rev-parse HEAD)
STUB_MODE=head STUB_HEAD="$main_branch" "$AGY_TASK" start gi13 "p" >/dev/null 2>&1 && fail "HEAD-redirecting run reported success"
nomark "agy gi13"
[ "$(jq -r .ok "$AGY_RES"/r1-*/gi13/result.json)" = false ] || fail "HEAD-redirecting run reported ok"
jq -r '.warnings[]' "$AGY_RES"/r1-*/gi13/result.json | grep -q "^git metadata changed during the run" || fail "HEAD record change not caught"
[ "$(git rev-parse "$main_branch")" = "$main_head" ] || fail "the worker's tree was committed onto $main_branch"
# a FIFO named .git must not hang the nested scan
STUB_MODE=fifo timeout 60 "$TASK" start gi14 "p" >/dev/null 2>&1 && fail "fifo run reported success"
blocked opencode "$OPENCODE_TASK_DIR" gi14 "^worker created a nested .git at sub/.git"
# legacy task (no recorded gitdir): resume refuses, plain clean refuses, clean --force works
jq 'del(.gitdir)' "$d3/opts.json" > "$T/o" && mv "$T/o" "$d3/opts.json"
out=$("$TASK" resume gi3 "again" 2>&1) && fail "legacy resume accepted"
echo "$out" | grep -q "started before git isolation" || fail "legacy resume message: $out"
out=$("$TASK" clean gi3 2>&1) && fail "legacy clean without --force accepted"
echo "$out" | grep -q "no recorded gitdir" || fail "legacy clean message: $out"
for s in gi1 gi2 gi3 gi6 gi8 gi9 gi10 gi12 gi14; do "$TASK" clean $s --force; done
for s in gi4 gi5 gi7 gi11 gi13; do "$AGY_TASK" clean $s --force; done
[ "$(git worktree list | wc -l)" = 1 ] || fail "clean left worktrees: $(git worktree list)"
[ -z "$(git branch --list 'opencode/gi*' 'agy/gi*')" ] || fail "clean left branches"
nomark "clean"
unset STUB_PLANT

# --- dispatch log: allowlisted fields only
export SWARMKIT_DISPATCH_LOG="$T/dispatch.jsonl"
"$TASK" start dl1 "PROMPT-SECRET please" >/dev/null 2>&1 || true
STUB_MODE=deny "$TASK" start dl2 "p" >/dev/null 2>&1 || true
[ "$(wc -l < "$SWARMKIT_DISPATCH_LOG")" = 4 ] || fail "expected a start and a finish line per task"
jq -es '[.[] | select(.event == "start")] | length == 2 and all(.[]; keys == ["agent","cli","effort","event","model","slug","ts"])' "$SWARMKIT_DISPATCH_LOG" >/dev/null \
  || fail "start lines not the allowlist"
jq -es '[.[] | select(.event == "finish")] | length == 2 and all(.[]; keys == ["agent","cli","denied","event","model","ok","slug","stopped_by","tokens","ts","wall_s"])' "$SWARMKIT_DISPATCH_LOG" >/dev/null \
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
