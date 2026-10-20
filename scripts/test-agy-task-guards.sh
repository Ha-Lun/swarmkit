#!/usr/bin/env bash
# Tests for the opencode-task guards: effort per model, circuit breaker, global cap, start banner, list, dispatch log,
# git isolation (both lanes). Stub `opencode` and `agy` CLIs on PATH; the opencode one emits the JSON-lines shape of `opencode run --format json` (no quota spent).
set -euo pipefail
TASK="$(cd "$(dirname "$0")" && pwd)/opencode-task"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export OPENCODE_TASK_DIR="$T/oc" AGY_TASK_DIR="$T/agy" PATH="$T/bin:$PATH" STUB_ARGS="$T/args" SWARMKIT_AGY_BRAIN_DIR="$T/brain"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
mkdir -p "$T/bin"
# STUB_MODE: ok (default) | deny (opencode: 12 permission errors, then hangs) | slow (opencode: sleeps STUB_SLEEP s first)
#   and on both lanes (bin/modes): tamper (points .git at the planted gitdir $STUB_PLANT) | tamperdir (replaces .git
#   with a copy of it) | symlink (.git -> $STUB_PLANT) | delete (removes .git) | nested (sub/.git -> $STUB_PLANT)
#   | gitmodules (writes .gitmodules) | meta (writes a file into $STUB_META, the main repo's info/)
#   | head (points this worktree's HEAD record at branch $STUB_HEAD) | fifo (sub/.git is a FIFO)
#   | wtswap (moves the worktree aside, leaves a symlink to it and points its .git at $STUB_PLANT)
#   | symref (turns this task's branch ref into a symref to $STUB_HEAD) | gconfig (writes $XDG_CONFIG_HOME/git/config)
#   | homecfg (writes $HOME/.gitconfig) | cwt / gwt (writes config.worktree in the common dir / this worktree's gitdir)
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
  wtswap) printf 'gitdir: %s\n' "$STUB_PLANT" > .git && d=$PWD && mv "$d" "$d.real" && ln -s "$d.real" "$d" ;;
  symref) g=$(sed 's/^gitdir: //' .git) && c=$(cd "$g" && cd "$(cat commondir)" && pwd) \
            && printf 'ref: refs/heads/%s\n' "$STUB_HEAD" > "$c/refs/heads/agy/$(basename "$(dirname "$PWD")")" ;;
  gconfig) mkdir -p "$XDG_CONFIG_HOME/git" && printf '[core]\n\tpager = touch planted\n' >> "$XDG_CONFIG_HOME/git/config" ;;
  homecfg) printf '[core]\n\tpager = touch planted\n' >> "$HOME/.gitconfig" ;;
  cwt) g=$(sed 's/^gitdir: //' .git) && c=$(cd "$g" && cd "$(cat commondir)" && pwd) \
         && printf '[core]\n\tpager = touch planted\n' > "$c/config.worktree" ;;
  gwt) printf '[core]\n\tpager = touch planted\n' > "$(sed 's/^gitdir: //' .git)/config.worktree" ;;
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
# The agy stub records its args and, as agy does, asks the gate hook in .agents/hooks.json about one tool call
# ($STUB_CALL, @WT@ = the worktree; default: write stub.txt), then writes stub.txt only if allowed. STUB_NOHOOK skips the hook (a hook
# agy did not run). Its transcript (in the --conversation, else a new one; STUB_CONV overrides) records that call
# (named STUB_TNAME if set, plus a STUB_EXTRA call); STUB_NOTRANSCRIPT writes none. --version prints $STUB_VERSION (1.4.2).
cat > "$T/bin/agy" <<'S'
#!/bin/sh
[ "$1" = --version ] && { echo "agy ${STUB_VERSION:-1.4.2}"; exit 0; }
printf '%s\n' "$*" >> "$STUB_ARGS.agy"
hook=$(jq -r '.[].PreToolUse[0].hooks[0].command' .agents/hooks.json 2>/dev/null)
call=${STUB_CALL:-"{\"toolCall\":{\"name\":\"write_to_file\",\"args\":{\"TargetFile\":\"$PWD/stub.txt\",\"CodeContent\":\"x\"}}}"}
call=$(printf '%s' "$call" | sed "s|@WT@|$PWD|g")
rm -f "$STUB_ARGS.gate"
[ -n "$hook" ] && [ -z "$STUB_NOHOOK" ] && printf '%s' "$call" | (cd .agents && sh -c "$hook") > "$STUB_ARGS.gate"
{ [ -z "$hook" ] || [ -n "$STUB_NOHOOK" ] || grep -q '"allow"' "$STUB_ARGS.gate"; } && echo stub > stub.txt
. "$(dirname "$0")/modes"
conv=$(printf '%s\n' "$@" | sed -n '/^--conversation$/{n;p;}')
conv=${STUB_CONV:-${conv:-$(cat /proc/sys/kernel/random/uuid)}}
if [ -z "$STUB_NOTRANSCRIPT" ]; then
  l="$SWARMKIT_AGY_BRAIN_DIR/$conv/.system_generated/logs"; mkdir -p "$l"
  extra=""; [ -n "$STUB_EXTRA" ] && extra=",{\"name\":\"$STUB_EXTRA\"}"
  printf '{"type":"PLANNER_RESPONSE","tool_calls":[{"name":"%s"}%s]}\n' \
    "${STUB_TNAME:-$(printf '%s' "$call" | jq -r .toolCall.name)}" "$extra" >> "$l/transcript_full.jsonl"
fi
printf '{"status":"SUCCESS","conversation_id":"%s","response":"done"}\n' "$conv"
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
# --agent model: the agent's own model when allowlisted, else the lane default with a notice
mkagent() { printf -- "---\n%s---\n" "$2" > "$SWARMKIT_OPENCODE_AGENTS_DIR/$1.md"; }
mkagent m-glm "model: opencode-go/glm-5.3-flash
"
mkagent m-kimi "model: opencode-go/kimi-k2.7-code
"
mkagent m-none "description: x
"
task_model() { jq -r .model "$(ls -d "$OPENCODE_TASK_DIR"/*/"$1"/opts.json 2>/dev/null | head -1)"; }
"$TASK" start am1 --agent m-glm "p" >/dev/null 2>&1 || true
[ "$(task_model am1)" = "opencode-go/glm-5.3-flash" ] || fail "agent model not used: $(task_model am1)"
err=$("$TASK" start am2 --agent m-kimi "p" 2>&1 >/dev/null) || true
[ "$(task_model am2)" = "opencode-go/muse-spark-1.3-contributor" ] || fail "kimi agent must fall back to muse: $(task_model am2)"
echo "$err" | grep -q "^opencode-task: agent m-kimi model opencode-go/kimi-k2.7-code is not on the worker allowlist; using opencode-go/muse-spark-1.3-contributor" || fail "kimi fallback notice: $err"
err=$("$TASK" start am3 --agent m-none "p" 2>&1 >/dev/null) || true
[ "$(task_model am3)" = "opencode-go/muse-spark-1.3-contributor" ] || fail "agent without model must use muse: $(task_model am3)"
echo "$err" | grep -q "allowlist" && fail "agent without model must not print a notice: $err"
"$TASK" start am4 --agent m-glm --model opencode-go/deepseek-v4.1-flash "p" >/dev/null 2>&1 || true
[ "$(task_model am4)" = "opencode-go/deepseek-v4.1-flash" ] || fail "--model must win over the agent: $(task_model am4)"
"$TASK" start am5 "p" >/dev/null 2>&1 || true
[ "$(task_model am5)" = "opencode-go/muse-spark-1.3-contributor" ] || fail "no --agent must use muse: $(task_model am5)"
for s in am1 am2 am3 am4 am5; do "$TASK" clean $s --force; done
unset SWARMKIT_OPENCODE_AGENTS_DIR

# --- git isolation: a worker that points .git at a gitdir it planted gets nothing run or committed there
AGY_RES="$AGY_TASK_DIR"
[ "$(jq -r '.permission.edit | to_entries | map(select(.value == "deny") | .key) | sort | join(" ")' "$STUB_ARGS.cfg")" \
  = "**/.git **/.git/* .git .git/*" ] || fail "overlay does not deny edits to .git: $(jq -c .permission.edit "$STUB_ARGS.cfg")"
[ "$(jq -r '.permission.edit | to_entries | first | "\(.key)=\(.value)"' "$STUB_ARGS.cfg")" = "*=allow" ] \
  || fail "the edit allow-all must come first (opencode: last match wins)"
# read-only git: --output, --no-index and --ext-diff are denied after the git allows (last match wins)
for k in "git * --ou*" "git * --no-i*" "git * --ext*"; do
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
# A1: the worktree was swapped for a symlink to itself (the pin check fails): nothing in it is restored or committed
STUB_MODE=wtswap "$AGY_TASK" start gi15 "p" >/dev/null 2>&1 && fail "worktree-swapping run reported success"
d=$(ls -d "$AGY_RES"/r1-*/gi15); nomark "agy gi15"
[ "$(jq -r .ok "$d/result.json")" = false ] || fail "gi15: a swapped worktree reported ok"
jq -r '.warnings[]' "$d/result.json" | grep -q "^worker modified .git or the worktree path" || fail "gi15: $(jq -c .warnings "$d/result.json")"
[ "$(cat "$d/worktree.real/.git")" = "gitdir: $STUB_PLANT" ] || fail "gi15: the swapped worktree was written to"
[ "$(git rev-parse agy/gi15)" = "$(cat "$d/base")" ] || fail "gi15: the run was committed"
# A2: the task's branch ref turned into a symref to the main branch: HEAD's symref chain ends there, no commit
STUB_MODE=symref STUB_HEAD="$main_branch" "$AGY_TASK" start gi16 "p" >/dev/null 2>&1 && fail "symref run reported success"
d=$(ls -d "$AGY_RES"/r1-*/gi16); nomark "agy gi16"
[ "$(jq -r .ok "$d/result.json")" = false ] || fail "gi16: a symref'd branch reported ok"
jq -r '.warnings[]' "$d/result.json" | grep -q "^worker moved HEAD to refs/heads/$main_branch" || fail "gi16: $(jq -c .warnings "$d/result.json")"
[ "$(git rev-parse "$main_branch")" = "$main_head" ] || fail "gi16: the worker's tree was committed onto $main_branch"
git update-ref --no-deref refs/heads/agy/gi16 "$(cat "$d/base")"
# the user's global git config (XDG) is part of the backstop
mkdir -p "$T/xdg"
XDG_CONFIG_HOME="$T/xdg" STUB_MODE=gconfig "$AGY_TASK" start gi17 "p" >/dev/null 2>&1 && fail "global-config run reported success"
blocked agy "$AGY_RES" gi17 "^git metadata changed during the run"
rm -rf "$T/xdg"
# ... and so are ~/.gitconfig and both config.worktree files
mkdir -p "$T/home"
HOME="$T/home" STUB_MODE=homecfg "$AGY_TASK" start gi18 "p" >/dev/null 2>&1 && fail "home-config run reported success"
blocked agy "$AGY_RES" gi18 "^git metadata changed during the run"
STUB_MODE=cwt "$AGY_TASK" start gi19 "p" >/dev/null 2>&1 && fail "common config.worktree run reported success"
blocked agy "$AGY_RES" gi19 "^git metadata changed during the run"
rm -f "$(git rev-parse --git-common-dir)/config.worktree"
STUB_MODE=gwt "$AGY_TASK" start gi20 "p" >/dev/null 2>&1 && fail "worktree config.worktree run reported success"
blocked agy "$AGY_RES" gi20 "^git metadata changed during the run"
# every git call the wrapper makes in a worktree takes attributes from the base commit (--attr-source)
mkdir -p "$T/gitshim"
printf '#!/bin/sh\n[ -n "$GIT_WORK_TREE" ] && printf "%%s\\n" "$*" >> "%s"\nexec "%s" "$@"\n' "$T/gitcalls" "$(command -v git)" > "$T/gitshim/git"
chmod +x "$T/gitshim/git"
PATH="$T/gitshim:$PATH" "$AGY_TASK" start gi21 "p" >/dev/null 2>&1 || fail "gi21 not ok: $(jq -c .warnings "$(ls -d "$AGY_RES"/r1-*/gi21)/result.json")"
[ "$(wc -l < "$T/gitcalls")" -ge 5 ] && ! grep -v -- "^--no-pager --attr-source=$(cat "$AGY_RES"/r1-*/gi21/base) " "$T/gitcalls" \
  || fail "a worktree git call without --attr-source: $(cat "$T/gitcalls")"
for s in gi4 gi5 gi7 gi11 gi13 gi15 gi16 gi17 gi18 gi19 gi20 gi21; do "$AGY_TASK" clean $s --force; done
[ "$(git worktree list | wc -l)" = 1 ] || fail "clean left worktrees: $(git worktree list)"
[ -z "$(git branch --list 'opencode/gi*' 'agy/gi*')" ] || fail "clean left branches"
nomark "clean"
unset STUB_PLANT

# --- agy gate: every sandboxed agy run (plain and --agent) gets the agy-gate.py PreToolUse hook, never committed
export SWARMKIT_AGY_AGENTS_DIR="$T/agy-agents"
mkdir -p "$SWARMKIT_AGY_AGENTS_DIR"
printf -- '---\nname: frontend-specialist\ndescription: d\n---\nBODY\n' > "$SWARMKIT_AGY_AGENTS_DIR/frontend-specialist.md"
adir() { ls -d "$AGY_TASK_DIR"/*/"$1"; }
ares() { jq -r "$2" "$(adir "$1")/result.json"; }
call() { printf '{"toolCall":{"name":"%s","args":%s}}' "$1" "$2"; }
# plain lane: the gate is installed, logs its allow, keeps a read-only shell (no test runner), and nothing of it is committed
"$AGY_TASK" start gp1 "p" >/dev/null 2>&1 || fail "plain gated agy run not ok: $(ares gp1 .warnings)"
W=$(adir gp1)/worktree
[ "$(jq -r .decision "$STUB_ARGS.gate")" = allow ] || fail "plain gate denied a worktree write: $(cat "$STUB_ARGS.gate")"
jq -e '.edit == true and (.shell | index("git diff *")) != null and ([.shell[] | select(test("^(npm|node|python|pytest|go|cargo|make|bun|yarn|pnpm)"))] == [])' "$(adir gp1)/gate.json" >/dev/null || fail "plain gate config: $(cat "$(adir gp1)/gate.json")"
grep -q "^allow write_to_file $W/stub.txt$" "$(adir gp1)/gate.log" || fail "gate did not log the allow: $(cat "$(adir gp1)/gate.log")"
[ "$(git -C "$W" show --name-only --format= HEAD)" = stub.txt ] || fail "gate overlay committed: $(git -C "$W" show --name-only --format= HEAD)"
grep -q -- "--agent" "$STUB_ARGS.agy" && fail "plain run passed --agent"
# plain lane: a write to a sibling dir is denied and reported
mkdir -p "$T/sib"
STUB_CALL=$(call write_to_file "{\"TargetFile\":\"$T/sib/x.txt\",\"CodeContent\":\"x\"}") "$AGY_TASK" start gp2 "p" >/dev/null 2>&1 \
  && fail "denied sibling write reported ok"
[ "$(ares gp2 '.denied_actions[0]')" = "write_to_file $T/sib/x.txt" ] || fail "sibling denial not in denied_actions: $(ares gp2 .denied_actions)"
# an agy that never ran the hook (empty gate log) while files changed is NOT ok, and its edits are not committed
uncommitted() { [ "$(git -C "$(adir "$1")/worktree" rev-parse HEAD)" = "$(cat "$(adir "$1")/base")" ] || fail "$1: committed"; }
STUB_NOHOOK=1 "$AGY_TASK" start gp3 "p" >/dev/null 2>&1 && fail "run with an inactive gate reported ok"
ares gp3 '.warnings[]' | grep -q "^gate hook inactive" || fail "no inactive-gate warning: $(ares gp3 .warnings)"
uncommitted gp3; [ -f "$(adir gp3)/worktree/stub.txt" ] || fail "gp3: the stub did not write"
# ... and so is one whose transcript has more tool calls (2) than gate decisions (1), or other names
STUB_EXTRA=view_file "$AGY_TASK" start gp4 "p" >/dev/null 2>&1 && fail "run with unseen tool calls reported ok"
ares gp4 '.warnings[]' | grep -q "^gate hook inactive: 1 gate decisions for 2 tool calls" || fail "transcript count: $(ares gp4 .warnings)"
uncommitted gp4
STUB_TNAME=run_command "$AGY_TASK" start gp8 "p" >/dev/null 2>&1 && fail "run with another tool in the transcript reported ok"
ares gp8 '.warnings[]' | grep -q "^gate hook inactive: 1 gate decisions for 1 tool calls" || fail "name match: $(ares gp8 .warnings)"
uncommitted gp8
# a missing transcript is not ok either, and neither is a resume that answered for another conversation
STUB_NOTRANSCRIPT=1 "$AGY_TASK" start gp9 "p" >/dev/null 2>&1 && fail "run without a transcript reported ok"
ares gp9 '.warnings[]' | grep -q "^gate check unavailable" || fail "no unavailable warning: $(ares gp9 .warnings)"
uncommitted gp9
"$AGY_TASK" resume gp1 "again" >/dev/null 2>&1 || fail "plain resume not ok: $(ares gp1 .warnings)"
h=$(git -C "$(adir gp1)/worktree" rev-parse HEAD)
STUB_CONV=0a1b2c3d-0000-4000-8000-000000000002 "$AGY_TASK" resume gp1 "again" >/dev/null 2>&1 && fail "resume in another conversation reported ok"
ares gp1 '.warnings[]' | grep -q "^gate check failed: agy answered for conversation 0a1b2c3d-0000-4000-8000-000000000002" \
  || fail "conversation check: $(ares gp1 .warnings)"
[ "$(git -C "$(adir gp1)/worktree" rev-parse HEAD)" = "$h" ] || fail "resume in another conversation was committed"
# an agy version other than the probed one is refused unless overridden
rc=0; out=$(STUB_VERSION=1.5.0 "$AGY_TASK" start gv1 "p" 2>&1) || rc=$?
[ "$rc" = 2 ] && echo "$out" | grep -q "agy 1.5.0 is not the version the gate was probed on (1.4.2)" || fail "unprobed agy ($rc): $out"
[ ! -e "$AGY_TASK_DIR"/*/gv1 ] || fail "unprobed agy left a task dir"
STUB_VERSION=1.5.0 AGY_TASK_ALLOW_UNPROBED=1 "$AGY_TASK" start gv1 "p" >/dev/null 2>&1 || fail "override not honoured: $(ares gv1 .warnings)"
# a launch is refused while the worktree has agy customization entries besides the overlay, or symlinks among them
for s in 'mkdir -p sub/.agents && echo {} > sub/.agents/hooks.json' 'ln -s /tmp .agents' 'mkdir _agent' \
         'mkdir .agents && ln -s /etc/hostname .agents/hooks.json' 'mkdir -p .agents && echo x > .agents/rules.md'; do
  rc=0; out=$("$AGY_TASK" start gr1 --setup "$s" "p" 2>&1) || rc=$?
  [ "$rc" = 2 ] && echo "$out" | grep -q "^agy-task: refusing to launch agy: " || fail "setup '$s' not refused ($rc): $out"
  [ ! -e "$(adir gr1)/worktree/stub.txt" ] || fail "agy ran after setup '$s'"
  "$AGY_TASK" clean gr1 --force
done
echo x > "$(adir gp1)/worktree/.agents/extra.json"
rc=0; out=$("$AGY_TASK" resume gp1 "again" 2>&1) || rc=$?
[ "$rc" = 2 ] && echo "$out" | grep -q "refusing to launch agy: .agents/extra.json" || fail "resume with a planted .agents file ($rc): $out"
# a repo that gitignores .agents/ still gets its run committed (git add fails on an exclude naming an ignored path)
echo '.agents/' > .gitignore && git add .gitignore && git commit -qm ignore
"$AGY_TASK" start gp6 "p" >/dev/null 2>&1 || fail "run in a repo ignoring .agents not ok: $(ares gp6 .warnings)"
[ "$(git -C "$(adir gp6)/worktree" show --name-only --format= HEAD)" = stub.txt ] || fail "gp6 commit"
git reset -q --hard HEAD~1
# --yolo: no hook, no inactive check
STUB_CALL=$(call list_dir '{"DirectoryPath":"@WT@/.agents"}') "$AGY_TASK" start gp7 "p" >/dev/null 2>&1 || true
[ "$(ares gp7 '.denied_actions | length')" = 0 ] && grep -q "^deny-quiet list_dir " "$(adir gp7)/gate.log" \
  || fail "a quiet denial counted: $(ares gp7 .denied_actions) $(cat "$(adir gp7)/gate.log")"
[ "$(ares gp7 .quiet_denials)" = 1 ] || fail "quiet_denials: $(ares gp7 .quiet_denials)"
"$AGY_TASK" start gp5 --yolo "p" >/dev/null 2>&1 || fail "yolo agy run not ok: $(ares gp5 .warnings)"
[ ! -e "$(adir gp5)/worktree/.agents/hooks.json" ] || fail "--yolo kept the gate"
# --agent: the agent overlay (file tools only) next to the gate; no shell in the gate either
rc=0; out=$("$AGY_TASK" start ag_agy --agent no-such-agent "hi" 2>&1) || rc=$?
[ "$rc" = 2 ] && echo "$out" | grep -q "^agy-task: unknown Antigravity agent: no-such-agent" || fail "unknown agy agent ($rc): $out"
[ ! -e "$AGY_TASK_DIR"/*/ag_agy ] || fail "agy lane agent left a task dir"
rc=0; "$AGY_TASK" start ag_agy2 --agent lead-dev-hybrid "hi" >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "agy lane orchestrator exit code: $rc"
for k in tools inheritMcp hooks plugins commandExecutionPolicy; do
  printf -- '---\nname: x\n%s: []\n---\nB\n' "$k" > "$SWARMKIT_AGY_AGENTS_DIR/own-${k,,}.md"
  rc=0; out=$("$AGY_TASK" start ag_own --agent "own-${k,,}" "hi" 2>&1) || rc=$?
  [ "$rc" = 2 ] && echo "$out" | grep -q "sets $k in its frontmatter" || fail "agent with its own $k accepted ($rc): $out"
done
"$AGY_TASK" start ga1 --agent frontend-specialist "p" >/dev/null 2>&1 || fail "agy agent start not ok: $(ares ga1 .warnings)"
grep -q -- "--agent frontend-specialist" "$STUB_ARGS.agy" || fail "agy --agent not passed: $(cat "$STUB_ARGS.agy")"
grep -q -- "-p Headless worker" "$STUB_ARGS.agy" || fail "agy agent prompt lacks the headless note"
jq -e '.shell == []' "$(adir ga1)/gate.json" >/dev/null || fail "--agent gate allows a shell"
W=$(adir ga1)/worktree
A="$W/.agents/agents/frontend-specialist/agent.md"
grep -q '^  - edit_file$' "$A" && ! grep -q 'run_command' "$A" && grep -q '^inheritMcp: false$' "$A" && grep -q '^BODY$' "$A" \
  || fail "agy agent overlay: $(cat "$A")"
[ "$(git -C "$W" show --name-only --format= HEAD)" = stub.txt ] || fail "overlay committed: $(git -C "$W" show --name-only --format= HEAD)"
rc=0; "$AGY_TASK" resume ga1 --agent frontend-specialist "again" >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "--agent on resume accepted ($rc)"
"$AGY_TASK" resume ga1 "again" >/dev/null 2>&1 || true
[ "$(grep -c -- '--agent frontend-specialist' "$STUB_ARGS.agy")" = 2 ] || fail "agy resume must keep --agent"
printf -- '---\nname: frontend-specialist\nhooks: {}\n---\nBODY\n' > "$SWARMKIT_AGY_AGENTS_DIR/frontend-specialist.md"
out=$("$AGY_TASK" resume ga1 "again" 2>&1) && fail "resume accepted an agent that now sets hooks"
echo "$out" | grep -q "sets hooks in its frontmatter" || fail "resume agent check message: $out"
printf -- '---\nname: frontend-specialist\ndescription: d\n---\nBODY\n' > "$SWARMKIT_AGY_AGENTS_DIR/frontend-specialist.md"
STUB_CALL=$(call view_file '{"AbsolutePath":"/etc/hostname"}') "$AGY_TASK" start ga2 --agent frontend-specialist "p" >/dev/null 2>&1 \
  && fail "outside read reported ok"
[ "$(ares ga2 '.denied_actions[0]')" = "view_file /etc/hostname" ] || fail "gate denial not in denied_actions"
"$AGY_TASK" start ga3 --agent frontend-specialist --review "p" >/dev/null 2>&1 || true
grep -q 'write_to_file' "$(adir ga3)/worktree/.agents/agents/frontend-specialist/agent.md" && fail "--review agent can edit"
jq -e '.edit == false' "$(adir ga3)/gate.json" >/dev/null || fail "--review gate allows edits"
# the gate itself (W = ga1's worktree)
G="${TASK%/*}/agy-gate.py"; ln -s /etc "$W/out"; mkdir -p "$W/sub/x"
cfg() { jq -n --arg r "$W" --arg l "$T/g.log" --argjson e "$1" --argjson s "$2" '{root: $r, log: $l, edit: $e, shell: $s}' > "$T/gate.json"; }
SH='["npm test","npm test *","ls","ls *","wc *","cat src/*","git log","git log *","git diff","git diff *"]'
cfg true "$SH"
gate() { printf '%s' "$2" | python3 -I "$G" "$T/gate.json" | jq -r .decision | grep -qx "$1" || fail "gate not $1: $2"; }
gate allow "$(call view_file "{\"AbsolutePath\":\"$W/stub.txt\",\"toolAction\":\"Reading\"}")"
gate allow "$(call edit_file "{\"Path\":\"$W/stub.txt\",\"Target\":\"a\",\"Replacement\":\"/etc/x\"}")"
gate allow "$(call find_by_name "{\"SearchDirectory\":\"$W\",\"Pattern\":\"*.txt\"}")"
gate allow "$(call view_file "{\"AbsolutePath\":\"$W/AGENTS.md\"}")"                         # rules: read-only, root only
gate allow "$(call write_to_file "{\"TargetFile\":\"$W/sub/AGENTS.md\",\"CodeContent\":\"x\"}")"
gate allow "$(call view_file "{\"AbsolutePath\":\"$W/stub.txt\",\"StartLine\":1,\"EndLine\":2,\"toolSummary\":\"s\"}")"
# only each tool's own argument keys (M3)
gate deny "$(call view_file "{\"AbsolutePath\":\"$W/stub.txt\",\"Foo\":\"x\"}")"
gate deny "$(call find_by_name "{\"SearchDirectory\":\"$W\",\"Pattern\":\"*\",\"Root\":true}")"
gate deny "$(call edit_file "{\"Path\":\"$W/stub.txt\",\"Target\":\"a\",\"Replacement\":\"b\",\"CodeContent\":\"c\"}")"
gate deny "$(call run_command "{\"CommandLine\":\"ls\",\"Cwd\":\"$W\",\"BypassSandbox\":true}")"
gate deny "$(call run_command '{"CommandLine":"ls"}')"                                        # no Cwd
gate deny "$(call write_to_file "{\"TargetFile\":\"$W/.agents/hooks.json\",\"CodeContent\":\"{}\"}")"
gate deny "$(call view_file "{\"AbsolutePath\":\"$W/out/hostname\"}")"                      # symlink out of the worktree
for p in sub/x/.git/config sub/.GIT sub/x/.Agents/hooks.json _agent/a _AGENTS .agent .gemini/config.json AGENTS.md Gemini.md; do      # .git and agy roots at any depth
  gate deny "$(call write_to_file "{\"TargetFile\":\"$W/$p\",\"CodeContent\":\"x\"}")"
done
: > "$T/g.log"; gate deny "$(call list_dir "{\"DirectoryPath\":\"$W/.agents\"}")"; gate deny "$(call view_file "{\"AbsolutePath\":\"$W/.git\"}")"
[ "$(cut -d' ' -f1 "$T/g.log" | tr '\n' ' ')" = "deny-quiet deny-quiet " ] || fail "guarded reads not quiet: $(cat "$T/g.log")"
gate deny "$(call view_file '{}')"                                                            # missing path
gate deny "$(call view_file '{"toolAction":"x"}')"                                            # no path at all
gate deny "$(call view_file '{"AbsolutePath":1}')"                                            # not a string
gate deny "$(call view_file "{\"AbsolutePath\":[\"$W/stub.txt\"]}")"                         # list-valued path
gate deny "$(call grep_search "{\"SearchPath\":\"$W\",\"Query\":\"q\",\"Includes\":[\"/etc/*\"]}")"   # path in a list
gate deny "$(call grep_search "{\"SearchPath\":\"$W\",\"Query\":\"q\",\"Opts\":{\"x\":\"../..\"}}")"  # path in a dict
gate deny "$(call view_file "{\"AbsolutePath\":\"$W/stub.txt\",\"OtherFile\":\"/etc/passwd\"}")"    # unknown path key
for u in "stub.txt" "~/x" "FILE://$W/stub.txt" "File://$W/stub.txt" "file://localhost$W/stub.txt" "file:$W/stub.txt" \
         "vscode-remote://$W/stub.txt" "http://x/y" "file://$W/%2Egit/config" "file://$W/%2e%61gents/hooks.json" \
         "file://$W/stub.txt" "file://$W/st%75b.txt" "file://$W/stub.txt?x" "file://$W/stub.txt#x" "file://$W/%252e" \
         "$W/sub\\\\..\\\\stub.txt" "$W\\\\stub.txt"; do        # any URL, file: too; backslashes (JSON-escaped here)
  gate deny "$(call view_file "{\"AbsolutePath\":\"$u\"}")"
done
gate deny "$(call browser_navigate '{"Url":"http://x"}')"
gate deny "$(call mcp_github_create_issue '{}')"
gate deny 'not json'
gate deny '{"toolCall":"view_file"}'
# shell: allowlisted commands only (the gate checks whatever list it gets), no shell syntax, paths inside the worktree,
# no git --output (or a prefix of it)
rc() { call run_command "{\"CommandLine\":\"$1\",\"Cwd\":\"${2:-$W}\"}"; }
gate allow "$(rc 'npm test')"; gate allow "$(rc 'git log --oneline -5')"; gate allow "$(rc 'cat src/a.js' "$W/sub")"
ln -s /etc/hostname "$W/README.md"; gate deny "$(rc 'ls README.md')"; rm "$W/README.md"           # a symlinked file
gate deny "$(call view_file "{\"AbsolutePath\":\"file://$W/a%0Ab\"}")"                        # decoded control char
for c in 'npm test; rm x' 'npm test && curl x' 'npm test | sh' 'ls $(id)' 'ls `id`' 'npm test > x' 'ls /etc' 'ls *' \
         'cat src/../../../etc/passwd' 'curl http://x' 'git diff --output=x' 'git diff --outp=x' 'git diff --no-index a b' \
         'git log --ext-diff' 'ls .git' 'ls sub/.Agents' 'git diff -O/etc/hostname' 'wc --files0-from=x' 'wc --files0=x' 'wc --f=x'; do
  gate deny "$(rc "$c")"
done
gate deny "$(rc 'npm test' /tmp)"
cfg false '[]'
gate deny "$(rc 'npm test')"                                                                   # --agent: no shell
gate deny "$(call edit_file "{\"Path\":\"$W/stub.txt\",\"Target\":\"a\",\"Replacement\":\"b\"}")"   # --review: no edits
gate allow "$(call list_dir "{\"DirectoryPath\":\"$W\"}")"
# every decision is logged, one line each, without control characters; a log it cannot write still gets a decision
: > "$T/g.log"
gate deny "$(call view_file "{\"AbsolutePath\":\"$W/a\\nallow view_file $W/b\"}")"
[ "$(wc -l < "$T/g.log")" = 1 ] && grep -q "^deny view_file $W/a?allow" "$T/g.log" || fail "gate log line: $(cat "$T/g.log")"
rm "$T/g.log" && ln -s "$T/elsewhere" "$T/g.log"
gate allow "$(call list_dir "{\"DirectoryPath\":\"$W\"}")"
[ ! -e "$T/elsewhere" ] || fail "gate log followed a symlink"
rm "$T/g.log"; ln -sf "$T/gate.json" "$T/gate-link.json"
printf '%s' "$(call list_dir "{\"DirectoryPath\":\"$W\"}")" | python3 -I "$G" "$T/gate-link.json" | jq -e '.decision == "deny"' >/dev/null \
  || fail "gate read its config through a symlink"
# a base that tracks anything in agy's customization dirs is refused, at any depth and any case, plain or --agent
for f in .agents/hooks.json docs/.Agent/x _agents .gemini/config.json; do
  mkdir -p "$(dirname "$f")" && echo '{}' > "$f" && git add -A && git commit -qm roots
  rc=0; out=$("$AGY_TASK" start ga4 "p" 2>&1) || rc=$?
  [ "$rc" = 2 ] && echo "$out" | grep -q "tracks $f: agy's customization dirs" || fail "tracked $f not refused ($rc): $out"
  git reset -q --hard HEAD~1
done
# a tracked symlink out of the worktree is warned about before launch
ln -s /etc etc-link && git add etc-link && git commit -qm link
"$AGY_TASK" start ga5 --setup 'ln -s /tmp setup-link' "p" >/dev/null 2>&1 || true
ares ga5 '.warnings[]' | grep -q "^symlinks point outside the worktree (etc-link, setup-link)" || fail "no symlink warning: $(ares ga5 .warnings)"
git reset -q --hard HEAD~1
for s in gp1 gp2 gp3 gp4 gp5 gp6 gp7 gp8 gp9 gv1 ga1 ga2 ga3 ga5; do "$AGY_TASK" clean $s --force; done
unset SWARMKIT_AGY_AGENTS_DIR

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
