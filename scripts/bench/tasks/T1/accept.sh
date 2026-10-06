. "$TASK_DIR/../_lib.sh"
! grep -rq 'contxt' core claude opencode antigravity || fail "typo still present"
grep -q 'context-gathering' core/agents/explore.md || fail "description lost its correct word"
build_in_sync
[ "$(changed_files | wc -l)" -le 6 ] || fail "too many files changed"
