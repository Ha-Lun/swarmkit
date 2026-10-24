#!/usr/bin/env python3
"""PreToolUse hook for every sandboxed agy-task run: agy-gate.py CONFIG < hook JSON.

agy-task writes CONFIG (task dir, outside the worktree) and points the worktree's .agents/hooks.json (a per-run
file, never committed) at this script. CONFIG: {"root": worktree, "log": file, "edit": bool, "shell": [globs]}.
Allowed: the file tools below on paths inside root, the edit tools only if "edit", and run_command only if its
command matches a "shell" glob (plain runs: the read-only part of the runner allowlist); a run_command without
Cwd (agy 1.4.7 has none) runs in agy's workspace, which agy-task launches in root. Everything else is denied:
other tools (MCP, browser, web), paths outside root, any path component named .git or one of agy's
customization roots (.agents, .gemini etc.: a written hooks.json would run commands), edits of the root
AGENTS.md or GEMINI.md (agy loads them as rules), relative paths, backslashes,
any URL scheme (file: too: agy never sends one, and a URL parser can read ?, # or % differently) and any
argument key outside the tool's schema below. Every decision is appended to the log ("allow|deny|deny-quiet TOOL TARGET"): agy leaves
hook denials out of its denied_actions, and an empty log after tool calls means the hook was not active.
deny-quiet is a read-only tool on .git or .agents (agy's list_dir shows the overlay dir, models look once):
denied, but agy-task does not count it as a denied action.
"""
import fnmatch, json, os, re, stat, sys

# tool -> (its path keys, all required; every other key it may have), from live probes of agy 1.4.2 and 1.4.7 (hook
# input and transcripts; 1.4.7 offers read_file/write_file and a Cwd-less run_command by default, the old names under
# --agent). A key outside both is denied: an unknown one could name a path (run_command's BypassSandbox).
COMMON = ("toolAction", "toolSummary")
READ = {"view_file": (("AbsolutePath",), ("StartLine", "EndLine")),
        "list_dir": (("DirectoryPath",), ()),
        "grep_search": (("SearchPath",), ("Query", "IsRegex", "MatchPerLine")),
        "find_by_name": (("SearchDirectory",), ("Pattern",)),
        "read_file": (("Path",), ())}
EDIT = {"write_to_file": (("TargetFile",), ("CodeContent", "Description", "Overwrite")),
        "edit_file": (("Path",), ("Target", "Replacement")),
        "write_file": (("Path",), ("Content", "Overwrite", "Append")),
        "replace_file_content": (("TargetFile",), ("TargetContent", "ReplacementContent", "StartLine", "EndLine",
                                                   "AllowMultiple", "Instruction", "Description"))}
SHELL = {"run_command": (("Cwd",), ("CommandLine", "WaitMsBeforeAsync"))}  # Cwd may be absent: then root
GUARDED = {".git", ".agents", ".agent", "_agents", "_agent", ".gemini"}
RULES = {"agents.md", "gemini.md"}  # agy loads these from the worktree root as rules: read-only for the worker
PATHY_KEY = re.compile(r"path|file|dir", re.I)
SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:")
CMD_CHARS = re.compile(r"[A-Za-z0-9_./=:@%+, -]+")  # no quotes, globs, redirects, separators or substitutions
GIT_DENY = ("--output", "--no-index", "--ext-diff", "--textconv")  # git also takes unique prefixes of these


class Guarded(ValueError):
    """A path in .git or an agy customization root."""


def read_nofollow(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise OSError(f"{path} is not a regular file")
        return f.read()


def resolve(v, root):
    """The real path for an argument value, or raise ValueError: plain absolute paths only."""
    if not isinstance(v, str) or not v:
        raise ValueError("path is missing or not a string")
    if re.search(r"[\x00-\x1f\x7f]", v):
        raise ValueError("control characters in a path")
    if SCHEME.match(v):
        raise ValueError("URLs are denied (file: too): absolute paths only")
    if "\\" in v:
        raise ValueError("backslashes in a path")
    if not v.startswith("/"):
        raise ValueError("only absolute paths")
    return inside(v, root)


def inside(v, root):
    for p in (os.path.normpath(v), os.path.realpath(v)):  # as written and with symlinks resolved
        if p != root and not p.startswith(root + os.sep):
            raise ValueError("only files inside the worktree")
        if GUARDED & {c.lower() for c in os.path.relpath(p, root).split(os.sep)}:
            raise Guarded(".git and agy customization files are off limits")
    return os.path.realpath(v)


def pathlike(x):
    if isinstance(x, str):
        return x.startswith(("/", "~", "\\")) or bool(SCHEME.match(x)) or ".." in re.split(r"[/\\]", x)
    if isinstance(x, list):
        return any(pathlike(y) for y in x)
    if isinstance(x, dict):
        return any(pathlike(y) for y in [*x, *x.values()])
    return False


def check_command(cmd, cwd, root, globs):
    if not isinstance(cmd, str) or not CMD_CHARS.fullmatch(cmd):
        raise ValueError("only allowlisted test/build commands, without shell syntax")
    words = cmd.split()
    if not words or not any(fnmatch.fnmatchcase(" ".join(words), g) for g in globs):
        raise ValueError("only allowlisted test/build commands")
    for w in words[1:]:
        if w.startswith("--") and len(w.split("=", 1)[0]) >= 3 and "--files0-from".startswith(w.split("=", 1)[0]):
            raise ValueError("--files0-from reads a list of paths")
        # the value after =, and after a short option (-O/etc/x)
        for c in [w] + w.split("=", 1)[1:] + ([w[2:]] if re.match(r"-[^-].", w) else []):
            if "/" in c or c.startswith(".") or os.path.lexists(os.path.join(cwd, c)):  # e.g. a symlinked README.md
                inside(os.path.join(cwd, c), root)
        if words[0] == "git" and any(len(o) >= 4 and (d.startswith(o) or o.startswith(d))
                                     for d in GIT_DENY for o in [w.split("=", 1)[0]]):
            raise ValueError("git may not write files, read outside the worktree or run external commands")


def decide(call, cfg):
    root = os.path.realpath(cfg["root"])
    name, args = call.get("name"), call.get("args")
    if not isinstance(name, str) or not isinstance(args, dict):
        raise ValueError("invalid tool call")
    tools = {**READ, **(EDIT if cfg.get("edit") else {}), **(SHELL if cfg.get("shell") else {})}
    if name not in tools:
        raise ValueError("only file tools inside the worktree; no MCP, browser or web" +
                         ("" if cfg.get("shell") else ", no shell"))
    keys, other = tools[name]
    if name in SHELL and "Cwd" not in args:  # absent, not empty or null: agy runs it in its workspace, root
        keys = ()
    paths = [resolve(args.get(k), root) for k in keys]
    for k, v in args.items():
        if k in keys:
            continue
        if k not in other + COMMON:
            raise ValueError(f"unexpected argument {k}")
        if isinstance(v, (list, dict)) and pathlike(v):
            raise ValueError(f"path-like value in {k}")
    if name in EDIT and any(os.path.relpath(p, root).lower() in RULES for p in paths):
        raise ValueError("the worktree's AGENTS.md and GEMINI.md are agy's rules: read-only for workers")
    if name in SHELL:
        check_command(args.get("CommandLine"), paths[0] if paths else root, root, cfg["shell"])


def target(call):
    """What the call is about, for the log: the command, else the first path-like argument as written."""
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    vals = [args.get("CommandLine")] + [v for k, v in args.items() if PATHY_KEY.search(k)]
    return next((v for v in vals if isinstance(v, str) and v), "")


def clean(s):
    return re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", "?", str(s))[:300]


def main():
    name, what, why, log, verdict = "?", "", "invalid hook input", None, "deny"
    try:
        cfg = json.loads(read_nofollow(sys.argv[1]))
        log = cfg["log"]
        call = json.loads(sys.stdin.read()).get("toolCall") or {}
        name, what = call.get("name", "?"), target(call)
        try:
            why = decide(call, cfg)
        except Guarded as e:  # a look at the overlay dir agy's list_dir shows: denied, but not held against the run
            why, verdict = str(e), "deny-quiet" if name in READ else "deny"
        except ValueError as e:
            why = str(e)
    except Exception:  # anything unexpected is a denial, never an allow
        pass
    if log:
        try:
            fd = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "a") as f:
                f.write(f"{verdict if why else 'allow'} {clean(name)} {clean(what)}".rstrip() + "\n")
        except Exception:
            pass
    print(json.dumps({"decision": "deny", "reason": why} if why else {"decision": "allow"}))


if __name__ == "__main__":
    main()
