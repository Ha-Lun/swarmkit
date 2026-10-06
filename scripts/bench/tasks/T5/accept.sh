. "$TASK_DIR/../_lib.sh"
g() { printf '{"tool_name":"%s","tool_input":{"command":"%s"}}' "$2" "$3" | python3 claude/hooks/guard.py "$1" >/dev/null 2>&1; echo $?; }
[ "$(g junior-dev Bash 'rm -rf build')" = 2 ] || fail "rm -rf not denied"
[ "$(g junior-dev Bash 'git push --force origin main')" = 2 ] || fail "push --force not denied"
[ "$(g junior-dev Bash 'git push -f')" = 2 ] || fail "push -f not denied"
[ "$(g junior-dev Bash 'ls -la')" = 0 ] || fail "ls denied"
[ "$(g junior-dev Bash 'git push origin main')" = 0 ] || fail "plain push denied"
[ "$(g explore Bash 'rm -rf build')" = 0 ] || fail "other agents are affected"
[ "$(g code-proofreader Bash 'rm x')" = 2 ] || fail "existing code-proofreader rule broke"
[ "$(g code-proofreader Bash 'grep x y')" = 0 ] || fail "existing code-proofreader allow broke"
grep -q 'guard.py junior-dev' claude/agents/junior-dev.md || fail "hook not wired into the generated claude agent"
build_in_sync
