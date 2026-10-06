. "$TASK_DIR/../_lib.sh"
python3 - <<'PY' || fail "TIER_MODELS check"
import importlib.util
s = importlib.util.spec_from_file_location('b', 'scripts/build.py'); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
assert m.TIER_MODELS['claude']['fast'] == 'sonnet', m.TIER_MODELS['claude']
assert m.TIER_MODELS['opencode']['fast'] == 'opencode/muse-spark-1.3-contributor-free', m.TIER_MODELS['opencode']
PY
! grep -rq '^model: haiku' claude/agents || fail "a claude agent still uses haiku"
git add -A >/dev/null 2>&1
git diff --cached --quiet "$BASE" -- opencode antigravity || fail "opencode/antigravity outputs changed"
build_in_sync
