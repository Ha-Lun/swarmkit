. "$TASK_DIR/../_lib.sh"
python3 - <<'PY' || fail "agent definition check"
import yaml
_, fm, body = open('core/agents/changelog-writer.md').read().split('---\n', 2)
a = yaml.safe_load(fm)
assert a['name'] == 'changelog-writer' and a['tier'] == 'fast', a
assert sorted(a['capabilities']) == ['edit', 'read'], a['capabilities']
assert a.get('description') and body.strip()
PY
[ -f claude/agents/changelog-writer.md ] || fail "no claude agent"
[ -f opencode/agents/changelog-writer.md ] || fail "no opencode agent"
[ -f antigravity/plugins/swarmkit/skills/changelog-writer/SKILL.md ] || fail "no antigravity skill"
grep -q '`changelog-writer`' core/rules/AGENTS.md || fail "not in the shared rules table"
grep -q 'changelog-writer' claude/CLAUDE.md || fail "generated claude/CLAUDE.md lacks it"
! grep -q '^tools:.*Bash' claude/agents/changelog-writer.md || fail "claude agent has Bash"
build_in_sync
