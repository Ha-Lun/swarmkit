# Shared helpers for accept.sh / solution.sh. cwd is the run's worktree; $BASE is the setup commit.
fail() { echo "FAIL: $*" >&2; exit 1; }
tree_hash() { git add -A >/dev/null 2>&1 && git write-tree; }
# The work must already include regenerated outputs: running the build must not change the tree (CLAUDE.md: "commit sources and outputs together").
build_in_sync() {
  local h0 h1 h2
  h0=$(tree_hash)
  python3 scripts/build.py >/dev/null || fail "scripts/build.py failed"
  h1=$(tree_hash)
  [ "$h0" = "$h1" ] || fail "generated outputs were not regenerated (build.py changed the tree)"
  python3 scripts/build.py >/dev/null || fail "second build failed"
  h2=$(tree_hash)
  [ "$h1" = "$h2" ] || fail "build is not idempotent"
}
changed_files() { git add -A >/dev/null 2>&1; git diff --cached --name-only "$BASE"; }
# svc fixture helpers
svc_tests() { (cd svc && python3 -m unittest discover -s tests >/dev/null 2>&1) || fail "the service's own tests fail"; }
svc_test_count() { grep -rh '^\s*def test_' svc/tests | wc -l; }
