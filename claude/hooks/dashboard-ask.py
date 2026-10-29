#!/usr/bin/env python3
"""PermissionRequest hook: forward AskUserQuestion / ExitPlanMode prompts to the local SwarmKit dashboard.

Stdlib only, run as `python3 -I`. It talks to the dashboard over the Unix socket named in
<config>/swarmkit/claude-hook.json, which must sit in a 0700 directory owned by the current user. It fails open to the terminal: any problem (no config, unsafe config file,
dashboard down, timeout, bad reply) exits 0 with no output, so Claude Code shows its normal dialog. It never
allows or denies on an error, and never prints the secret.
"""
import http.client
import json
import os
import re
import socket
import stat
import struct
import sys

TOOLS = {"AskUserQuestion", "ExitPlanMode"}
MODES = {"auto", "acceptEdits"}
HOOK_PATH = "/api/claude-hook"
MAX_STDIN = 1024 * 1024
MAX_REPLY = 1024 * 1024
MAX_CONFIG = 4096
MAX_MESSAGE = 4000
MAX_ANSWERS = 4
MAX_ANSWER = 4000
TIMEOUT = 870


class Pass(Exception):
    """Leave the decision to the terminal dialog."""


class UnixHTTPConnection(http.client.HTTPConnection):
    """HTTP over a Unix domain socket (no proxies, no redirects: only the one request is made)."""

    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(self.timeout)
            sock.connect(self._path)
            check_peer(sock)
        except BaseException:
            sock.close()
            raise
        self.sock = sock


def check_peer(sock):
    """Raise Pass unless the process listening on the socket runs as this user (Linux SO_PEERCRED)."""
    so_peercred = getattr(socket, "SO_PEERCRED", None)
    if so_peercred is None:
        return
    size = struct.calcsize("3i")
    _pid, uid, _gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, so_peercred, size))
    if uid != os.geteuid():
        raise Pass("dashboard socket is served by another user")


def ancestors_safe(d):
    """True when every ancestor of the real config dir is owned by root or this user and cannot be swapped by others."""
    parent = os.path.dirname(os.path.realpath(d))
    while True:
        st = os.lstat(parent)
        if st.st_uid not in (0, os.geteuid()):
            return False
        if st.st_mode & 0o022 and not st.st_mode & stat.S_ISVTX:
            return False
        up = os.path.dirname(parent)
        if up == parent:
            return True
        parent = up


def config_dir():
    base = (os.environ.get("XDG_CONFIG_HOME") or "").strip()
    if not os.path.isabs(base):
        base = os.path.expanduser("~/.config")
    return os.path.join(os.path.normpath(base), "swarmkit")


def config_path():
    return os.path.join(config_dir(), "claude-hook.json")


def private_to_me(st):
    return st.st_uid == os.geteuid() and not st.st_mode & 0o077


def load_config():
    """Return (socket path, secret) from the dashboard's config file, or raise Pass when it is missing or unsafe."""
    d = config_dir()
    try:
        dst = os.lstat(d)
    except OSError:
        raise Pass("no dashboard config")
    if not stat.S_ISDIR(dst.st_mode) or not private_to_me(dst):
        raise Pass("dashboard config directory is not private to this user")
    if getattr(socket, "SO_PEERCRED", None) is None:
        # No peer credentials here (e.g. macOS): the path to the socket must not be replaceable by others.
        try:
            safe = ancestors_safe(d)
        except OSError:
            safe = False
        if not safe:
            raise Pass("dashboard config directory has an unsafe parent")
    try:
        fd = os.open(config_path(), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise Pass("no dashboard config")
    with os.fdopen(fd, "rb") as fh:
        st = os.fstat(fh.fileno())
        if not stat.S_ISREG(st.st_mode) or not private_to_me(st) or st.st_size > MAX_CONFIG:
            raise Pass("dashboard config file is not private to this user")
        raw = fh.read(MAX_CONFIG + 1)
    if len(raw) > MAX_CONFIG:
        raise Pass("dashboard config file too large")
    try:
        cfg = json.loads(raw.decode("utf-8"))
        sock, secret = cfg["socket"], cfg["secret"]
    except (ValueError, KeyError, TypeError):
        raise Pass("dashboard config is invalid")
    if not isinstance(secret, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", secret):
        raise Pass("dashboard config has a bad secret")
    if not isinstance(sock, str) or not os.path.isabs(sock) or os.path.normpath(sock) != sock or os.path.dirname(sock) != d:
        raise Pass("dashboard socket is not inside the config directory")
    try:
        sst = os.lstat(sock)
    except OSError:
        raise Pass("dashboard socket is missing")
    if not stat.S_ISSOCK(sst.st_mode) or sst.st_uid != os.geteuid():
        raise Pass("dashboard socket is not a socket owned by this user")
    return sock, secret


def ask_dashboard(sock, secret, body):
    conn = UnixHTTPConnection(sock, TIMEOUT)
    try:
        conn.request(
            "POST",
            HOOK_PATH,
            body=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-swarmkit-hook": secret},
        )
        resp = conn.getresponse()
        if resp.status != 200:
            raise Pass("dashboard replied HTTP %d" % resp.status)
        raw = resp.read(MAX_REPLY + 1)
    except (http.client.HTTPException, OSError, ValueError) as e:
        raise Pass("dashboard unreachable (%s)" % type(e).__name__)
    finally:
        conn.close()
    if len(raw) > MAX_REPLY:
        raise Pass("dashboard reply too large")
    try:
        reply = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise Pass("dashboard reply is not JSON")
    if not isinstance(reply, dict):
        raise Pass("dashboard reply is not an object")
    return reply


def valid_answers(answers, tool_input):
    """The dashboard's answers, only if each key is one of the asked question texts and each value is a short string."""
    questions = tool_input.get("questions")
    asked = {q.get("question") for q in questions if isinstance(q, dict)} if isinstance(questions, list) else set()
    if not isinstance(answers, dict) or len(answers) > MAX_ANSWERS:
        raise Pass("dashboard answers are invalid")
    for key, value in answers.items():
        if key not in asked or not isinstance(value, str) or len(value) > MAX_ANSWER:
            raise Pass("dashboard answers do not match the questions")
    return answers


def to_output(reply, data):
    """Map the dashboard's reply to Claude Code's PermissionRequest output; raise Pass for anything else.

    The input and the mode are decided here from the hook's own data, never taken from the reply.
    """
    kind = reply.get("decision")
    tool_input = data["tool_input"]
    if kind == "allow":
        decision = {"behavior": "allow"}
        if data["tool_name"] == "AskUserQuestion":
            decision["updatedInput"] = {**tool_input, "answers": valid_answers(reply.get("answers"), tool_input)}
        else:  # ExitPlanMode (run() admits no other tool)
            decision["updatedInput"] = tool_input
            if reply.get("mode") in MODES and data.get("permission_mode") == "plan":
                decision["updatedPermissions"] = [{"type": "setMode", "mode": reply["mode"], "destination": "session"}]
    elif kind == "deny":
        message = reply.get("message")
        if not isinstance(message, str) or not message:
            message = "Denied in SwarmKit"
        decision = {"behavior": "deny", "message": message[:MAX_MESSAGE]}
    else:
        raise Pass("pass or unknown decision")
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}


def run():
    raw = sys.stdin.buffer.read(MAX_STDIN + 1)
    if len(raw) > MAX_STDIN:
        raise Pass("hook input too large")
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise Pass("hook input is not JSON")
    if not isinstance(data, dict) or data.get("hook_event_name") != "PermissionRequest" or data.get("tool_name") not in TOOLS:
        raise Pass("")
    if not isinstance(data.get("tool_input"), dict):
        raise Pass("tool_input is not an object")
    sock, secret = load_config()
    body = {k: data.get(k) for k in ("session_id", "transcript_path", "tool_name", "tool_input")}
    return to_output(ask_dashboard(sock, secret, body), data)


def main():
    try:
        out = run()
    except Pass as e:
        if str(e):
            print("swarmkit dashboard-ask: %s; using the terminal prompt" % e, file=sys.stderr)
        return
    except Exception as e:  # a bug must not block or auto-answer the prompt
        print("swarmkit dashboard-ask: %s; using the terminal prompt" % type(e).__name__, file=sys.stderr)
        return
    sys.stdout.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
