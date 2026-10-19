#!/usr/bin/env python3
"""PreToolUse hook for `agy-task start --agent`: agy-gate.py WORKTREE DENYLOG < hook JSON.

agy-task writes it into the worktree's .agents/hooks.json (a per-run file, never committed). It allows the
file tools on paths inside WORKTREE and denies everything else: other tools (shell, MCP, browser), paths
outside WORKTREE, and agy's customization roots (.agents/ etc.: a written hooks.json would run commands).
Each denial is appended to DENYLOG, because agy leaves hook denials out of its denied_actions.
"""
import json, os, re, sys

FILE_TOOLS = {"view_file", "list_dir", "grep_search", "find_by_name",
              "write_to_file", "edit_file", "multi_replace_file_content"}
root, log = os.path.realpath(sys.argv[1]), sys.argv[2]
guarded = [os.path.join(root, d) for d in (".agents", ".agent", "_agents", "_agent")]


def within(p, d):
    return p == d or p.startswith(d + os.sep)


name, why = "?", "invalid hook input"
try:
    call = json.load(sys.stdin).get("toolCall") or {}
    name, args = call.get("name", "?"), call.get("args") or {}
    paths = [os.path.realpath(os.path.join(root, os.path.expanduser(v.removeprefix("file://"))))
             for k, v in args.items() if isinstance(v, str) and v and re.search(r"path|file|dir", k, re.I)]
    if name not in FILE_TOOLS:
        why = "only file tools inside the worktree; no shell, MCP or browser"
    elif not all(within(p, root) for p in paths):
        why = "only files inside the worktree"
    elif any(within(p, g) for p in paths for g in guarded):
        why = "agy customization files are off limits"
    else:
        why = None
    target = paths[0] if paths else ""
except Exception:  # anything unexpected is a denial, never an allow
    target = ""
if why:
    with open(log, "a") as f:
        f.write(f"{name} {target}".strip() + "\n")
print(json.dumps({"decision": "deny", "reason": why} if why else {"decision": "allow"}))
