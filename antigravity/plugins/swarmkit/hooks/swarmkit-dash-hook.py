#!/usr/bin/env python3
"""PreToolUse hook gating sandboxed `agy` dashboard sessions (stdlib only, run as `python3 -I`)."""
import json
import os
import sys
import urllib.request

READ_PATHS = {
    "view_file": ("AbsolutePath",),
    "read_file": ("Path",),
    "list_dir": ("DirectoryPath",),
    "grep_search": ("SearchPath",),
    "find_by_name": ("SearchDirectory",),
}
EDIT_PATHS = {
    "write_to_file": ("TargetFile",),
    "replace_file_content": ("TargetFile",),
    "multi_replace_file_content": ("TargetFile",),
    "edit_file": ("Path",),
    "write_file": ("Path",),
}
GUARDED = {".git", ".agents", ".agent", ".gemini"}
RULES = {"agents.md", "gemini.md"}  # agy loads these from the session root as rules: edits ask the dashboard
# Edits to these run code or change tool config later: they always ask the dashboard (any depth, case-insensitive).
SENSITIVE_DIRS = {".claude", ".opencode", ".vscode", ".husky", ".github", ".devcontainer", ".idea"}
SENSITIVE_FILES = {
    "claude.md", "agents.md", "gemini.md", ".mcp.json", "opencode.json", "opencode.jsonc", ".envrc",
    "package.json", "makefile", ".gitattributes", ".gitmodules",
}


def check_path(value, root):
    if not isinstance(value, str) or not value:
        raise ValueError("bad path")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("control characters in a path")
    if not value.startswith("/"):
        raise ValueError("only absolute paths")
    resolved = os.path.realpath(value)
    if resolved != root and not resolved.startswith(root + os.sep):
        raise ValueError("only files inside the session cwd")
    parts = os.path.relpath(resolved, root).split(os.sep)
    if any(p.lower() in GUARDED for p in parts):
        raise ValueError(".git and agy customization files are off limits")
    return resolved


def auto_allowed(name, args, root):
    paths = READ_PATHS.get(name)
    if paths is None:
        edit, paths = True, EDIT_PATHS.get(name)
    else:
        edit = False
    if paths is None or not isinstance(args, dict):
        return False
    try:
        resolved = [check_path(args.get(key), root) for key in paths]
    except ValueError:
        return False
    if edit and any(os.path.relpath(p, root).lower() in RULES or sensitive_edit(p, root) for p in resolved):
        return False
    return True


def sensitive_edit(resolved, root):
    parts = [p.lower() for p in os.path.relpath(resolved, root).split(os.sep)]
    if any(p in SENSITIVE_DIRS for p in parts[:-1]) or parts[-1] in SENSITIVE_DIRS:
        return True
    if parts[-1] in SENSITIVE_FILES or parts[-1].startswith(".env"):
        return True
    try:
        return os.stat(resolved).st_nlink > 1
    except OSError:
        return False


def ask_dashboard(url, secret, raw):
    req = urllib.request.Request(
        url,
        data=raw,
        headers={"content-type": "application/json", "x-swarmkit-hook": secret},
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=870) as resp:
        try:
            payload = json.loads(resp.read().decode("utf-8"))
        except ValueError:
            payload = {}
        if resp.status == 200 and isinstance(payload, dict) and payload.get("decision") == "allow":
            return {"decision": "allow"}
        reason = payload.get("reason") if isinstance(payload, dict) else None
        return {"decision": "deny", "reason": reason or "denied in the Swarmkit dashboard"}


def decide():
    url = os.environ.get("SWARMKIT_DASH_HOOK_URL")
    secret = os.environ.get("SWARMKIT_DASH_HOOK_SECRET")
    if not url or not secret:
        return {"decision": "allow"}
    raw = sys.stdin.read()
    body = json.loads(raw)
    call = body.get("toolCall") if isinstance(body, dict) else None
    if not isinstance(call, dict):
        call = {}
    root = os.path.realpath(os.environ.get("SWARMKIT_DASH_CWD") or os.getcwd())
    if auto_allowed(call.get("name"), call.get("args"), root):
        return {"decision": "allow"}
    return ask_dashboard(url, secret, raw.encode("utf-8"))


def main():
    try:
        out = decide()
    except BaseException:
        out = {"decision": "deny", "reason": "swarmkit hook error"}
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
