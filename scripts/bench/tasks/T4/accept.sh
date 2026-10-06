. "$TASK_DIR/../_lib.sh"
git add -A >/dev/null 2>&1
python3 scripts/build.py >/dev/null || fail "plain build broke"
before=$(tree_hash)
python3 scripts/build.py --check >/dev/null 2>&1 || fail "--check should exit 0 on an up-to-date tree"
[ "$(tree_hash)" = "$before" ] || fail "--check wrote files on a clean tree"
sed -i '/^description:/s/$/ (stale check)/' core/agents/junior-dev.md
before=$(tree_hash)
out=$(python3 scripts/build.py --check 2>&1); rc=$?
[ $rc -eq 1 ] || fail "--check should exit 1 on a stale tree, got $rc"
echo "$out" | grep -q 'junior-dev' || fail "--check did not name a stale output"
[ "$(tree_hash)" = "$before" ] || fail "--check wrote files on a stale tree"
python3 scripts/build.py >/dev/null || fail "plain build broke"
python3 scripts/build.py --check >/dev/null 2>&1 || fail "--check should pass after a real build"
