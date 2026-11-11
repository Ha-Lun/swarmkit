#!/usr/bin/env python3
"""PreToolUse hook gating sandboxed `agy` dashboard sessions (stdlib only, run as `python3 -I`)."""
import json
import os
import re
import shlex
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


def auto_allowed(name, args, root, images_root=None):
    paths = READ_PATHS.get(name)
    if paths is None:
        edit, paths = True, EDIT_PATHS.get(name)
    else:
        edit = False
    if paths is None or not isinstance(args, dict):
        return False
    resolved = []
    for key in paths:
        try:
            resolved.append(check_path(args.get(key), root))
        except ValueError:
            # Reads (never edits) may also reach the session's pasted-image directory.
            if edit or not images_root:
                return False
            try:
                check_path(args.get(key), images_root)
            except ValueError:
                return False
    if edit and any(os.path.relpath(p, root).lower() in RULES or sensitive_edit(p, root) for p in resolved):
        return False
    if edit:
        settings = os.path.realpath(settings_path())
        if any(p == settings or ".gemini" in (q.lower() for q in p.split(os.sep)) for p in resolved):
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

def settings_path():
    return os.environ.get("SWARMKIT_DASH_AGY_SETTINGS") or os.path.expanduser("~/.gemini/antigravity-cli/settings.json")


def load_rules():
    """Read the agy CLI's own `command(...)` permission rules; any problem yields empty lists."""
    try:
        with open(settings_path(), encoding="utf-8") as fh:
            perms = json.load(fh).get("permissions")
        return parse_rules(perms.get("allow")), parse_rules(perms.get("deny"))
    except Exception:
        return [], []


def parse_rules(entries):
    rules = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, str):
            continue
        entry = entry.strip()
        if not (entry.startswith("command(") and entry.endswith(")")):
            continue
        try:
            tokens = shlex.split(entry[8:-1])
        except ValueError:
            continue
        if tokens:
            rules.append(tokens)
    return rules


def split_command(cmd):
    """Quote-aware split on && || ; | newline. Returns (segments, unsafe) or None when quoting is unbalanced."""
    segs, cur, unsafe = [], [], "\r" in cmd
    quote = None
    i, n = 0, len(cmd)
    while i < n:
        c = cmd[i]
        nxt = cmd[i + 1] if i + 1 < n else ""
        if quote == "'":
            if c == "'":
                quote = None
            elif c == "\n":
                unsafe = True
            cur.append(c)
        elif quote == '"':
            if c == "\\":
                cur.append(c + nxt)
                i += 1
                if nxt == "\n":
                    unsafe = True
            else:
                if c == '"':
                    quote = None
                elif c == "`" or (c == "$" and nxt in ("(", "{")) or c == "\n":
                    unsafe = True
                cur.append(c)
        elif c == "\\":
            cur.append(c + nxt)
            i += 1
            if nxt == "\n":
                unsafe = True
        elif c in "'\"":
            quote = c
            cur.append(c)
        elif c == "`" or c in "<>" or (c == "$" and nxt in ("(", "{", "'")):
            unsafe = True
            cur.append(c)
        elif c == "#" and (not cur or cur[-1].isspace()):
            unsafe = True  # a comment: bash would ignore the rest, the hook would not
            cur.append(c)
        elif c == "&" and nxt != "&":
            unsafe = True
            cur.append(c)
        elif c in ";\n" or c in "&|":
            if c in "&|" and nxt == c:
                i += 1
            segs.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    if quote:
        return None
    segs.append("".join(cur))
    return segs, unsafe


def command_decision(cmd):
    """Return "allow", "deny" or None (ask) for a shell command line using the agy CLI's own rules."""
    if not isinstance(cmd, str) or not cmd.strip():
        return None
    allow, deny = load_rules()
    split = split_command(cmd.strip() if "\r" not in cmd else cmd)
    if split is None:
        return None
    segs, unsafe = split
    tokenized = []
    for seg in segs:
        if not seg.strip():
            continue
        try:
            tokenized.append(shlex.split(seg))
        except ValueError:
            unsafe = True
            tokenized.append(None)
    if not tokenized:
        return None

    def matches(tokens, rules):
        return any(tokens[: len(r)] == r for r in rules)

    if any(t and matches(t, deny) for t in tokenized):
        return "deny"
    if unsafe:
        return None
    for t in tokenized:
        if not t or re.match(r"[A-Za-z_][A-Za-z0-9_]*=", t[0]):
            return None
        if not ((t[0] == "cd" and len(t) <= 2) or matches(t, allow)):
            return None
    return "allow"


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
    if not url and not secret:
        return {"decision": "allow"}
    if not url or not secret:
        return {"decision": "deny", "reason": "incomplete swarmkit hook configuration"}
    raw = sys.stdin.read()
    body = json.loads(raw)
    call = body.get("toolCall") if isinstance(body, dict) else None
    if not isinstance(call, dict):
        call = {}
    root = os.path.realpath(os.environ.get("SWARMKIT_DASH_CWD") or os.getcwd())
    images = os.environ.get("SWARMKIT_DASH_IMAGES_DIR")
    images_root = os.path.realpath(images) if images and images.startswith("/") else None
    if auto_allowed(call.get("name"), call.get("args"), root, images_root):
        return {"decision": "allow"}
    if call.get("name") == "run_command" and isinstance(call.get("args"), dict):
        verdict = command_decision(call["args"].get("CommandLine"))
        if verdict == "allow":
            return {"decision": "allow"}
        if verdict == "deny":
            return {"decision": "deny", "reason": "denied by your agy settings (permissions.deny)"}
    return ask_dashboard(url, secret, raw.encode("utf-8"))


def main():
    try:
        out = decide()
    except BaseException:
        out = {"decision": "deny", "reason": "swarmkit hook error"}
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
