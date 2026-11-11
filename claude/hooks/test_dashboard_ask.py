"""Tests for dashboard-ask.py. Run: python3 -I claude/hooks/test_dashboard_ask.py"""
import importlib.util
import json
import os
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard-ask.py")
spec = importlib.util.spec_from_file_location("dashboard_ask", HOOK)
ask = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ask)
SECRET = "ab" * 32
QUESTIONS = {"questions": [{"question": "Pick?"}, {"question": "Layout?"}]}


class Dashboard(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """Local stand-in for the dashboard on a Unix socket: records requests, replies with self.status / self.body."""

    daemon_threads = True

    def __init__(self, path):
        super().__init__(path, Handler)
        self.status, self.body, self.requests = 200, b'{"decision":"pass"}', []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.server.requests.append({"path": self.path, "headers": dict(self.headers), "body": self.rfile.read(n)})
        self.send_response(self.server.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.server.body)))
        self.end_headers()
        self.wfile.write(self.server.body)

    def log_message(self, *args):
        pass


def event(tool="AskUserQuestion", name="PermissionRequest", tool_input=None, mode="default"):
    return {
        "session_id": "s1", "transcript_path": "/t.jsonl", "cwd": "/work", "permission_mode": mode,
        "hook_event_name": name, "tool_name": tool,
        "tool_input": QUESTIONS if tool_input is None else tool_input,
    }


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "swarmkit")
        os.makedirs(self.dir, mode=0o700)
        os.chmod(self.dir, 0o700)
        self.sock = os.path.join(self.dir, "claude-hook.sock")
        self.server = Dashboard(self.sock)
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.02,), daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.write_config({"socket": self.sock, "secret": SECRET})

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def write_config(self, cfg, mode=0o600):
        path = os.path.join(self.dir, "claude-hook.json")
        with open(path, "w") as f:
            f.write(cfg if isinstance(cfg, str) else json.dumps(cfg))
        os.chmod(path, mode)
        return path

    def run_hook(self, payload=None, env=None, raw=None):
        e = {"PATH": os.environ.get("PATH", ""), "HOME": self.tmp.name, "XDG_CONFIG_HOME": self.tmp.name}
        e.update(env or {})
        stdin = raw if raw is not None else json.dumps(event() if payload is None else payload)
        p = subprocess.run([sys.executable, "-I", HOOK], input=stdin, capture_output=True, text=True, env=e, timeout=30)
        self.assertEqual(p.returncode, 0)
        self.assertNotIn(SECRET, p.stdout + p.stderr)
        return p.stdout

    def reply(self, obj):
        self.server.body = json.dumps(obj).encode()

    def decision(self, out):
        o = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(o["hookEventName"], "PermissionRequest")
        return o["decision"]

    def test_pass(self):
        self.assertEqual(self.run_hook(), "")
        self.assertEqual(len(self.server.requests), 1)

    def test_request_shape_and_secret_header(self):
        self.run_hook()
        req = self.server.requests[0]
        req["headers"] = {k.lower(): v for k, v in req["headers"].items()}
        self.assertEqual(req["path"], "/api/claude-hook")
        self.assertEqual(req["headers"]["x-swarmkit-hook"], SECRET)
        self.assertEqual(req["headers"]["content-type"], "application/json")
        body = json.loads(req["body"])
        self.assertEqual(set(body), {"session_id", "transcript_path", "tool_name", "tool_input"})
        self.assertEqual(body["tool_name"], "AskUserQuestion")
        self.assertEqual(body["session_id"], "s1")

    def test_allow_question_builds_input_locally(self):
        self.reply({"decision": "allow", "answers": {"Pick?": "A", "Layout?": "Grid"}, "updatedInput": {"evil": 1}})
        d = self.decision(self.run_hook())
        self.assertEqual(d, {"behavior": "allow", "updatedInput": {**QUESTIONS, "answers": {"Pick?": "A", "Layout?": "Grid"}}})

    def test_allow_question_rejects_bad_answers(self):
        bad = ({"Other?": "A"}, {"Pick?": 5}, {"Pick?": "x" * 4001}, {"Pick?": ["A"]}, "A", ["A"], None,
               {"Pick?": "A", "Layout?": "B", "c": "x", "d": "y", "e": "z"})
        for answers in bad:
            self.reply({"decision": "allow", "answers": answers})
            self.assertEqual(self.run_hook(), "", repr(answers)[:40])
        self.reply({"decision": "allow"})
        self.assertEqual(self.run_hook(), "")
        self.reply({"decision": "allow", "answers": {"Pick?": "x" * 4000}})
        self.assertEqual(self.decision(self.run_hook())["behavior"], "allow")

    def test_allow_plan_with_mode_only_from_plan_mode(self):
        for mode in ("auto", "acceptEdits"):
            self.reply({"decision": "allow", "mode": mode})
            d = self.decision(self.run_hook(event("ExitPlanMode", tool_input={"plan": "p"}, mode="plan")))
            self.assertEqual(d["behavior"], "allow")
            self.assertEqual(d["updatedInput"], {"plan": "p"})
            self.assertEqual(d["updatedPermissions"], [{"type": "setMode", "mode": mode, "destination": "session"}])

    def test_plan_mode_ignored_outside_plan_mode(self):
        self.reply({"decision": "allow", "mode": "auto"})
        for mode in ("default", "acceptEdits", "auto", "bypassPermissions", None):
            d = self.decision(self.run_hook(event("ExitPlanMode", tool_input={"plan": "p"}, mode=mode)))
            self.assertEqual(d, {"behavior": "allow", "updatedInput": {"plan": "p"}}, mode)

    def test_mode_never_applies_to_questions(self):
        self.reply({"decision": "allow", "mode": "auto", "answers": {"Pick?": "A"}})
        d = self.decision(self.run_hook(event(mode="plan")))
        self.assertNotIn("updatedPermissions", d)

    def test_allow_plan_ignores_server_input(self):
        self.reply({"decision": "allow", "updatedInput": {"plan": "evil"}})
        d = self.decision(self.run_hook(event("ExitPlanMode", tool_input={"plan": "p"}, mode="plan")))
        self.assertEqual(d, {"behavior": "allow", "updatedInput": {"plan": "p"}})

    def test_allow_plan_with_invalid_mode(self):
        for mode in ("bypassPermissions", "plan", 5, None, ""):
            self.reply({"decision": "allow", "mode": mode})
            d = self.decision(self.run_hook(event("ExitPlanMode", tool_input={"plan": "p"}, mode="plan")))
            self.assertEqual(d, {"behavior": "allow", "updatedInput": {"plan": "p"}})

    def test_deny_with_message(self):
        self.reply({"decision": "deny", "message": "No thanks"})
        self.assertEqual(self.decision(self.run_hook()), {"behavior": "deny", "message": "No thanks"})

    def test_deny_default_and_capped_message(self):
        self.reply({"decision": "deny"})
        self.assertEqual(self.decision(self.run_hook())["message"], "Denied in SwarmKit")
        self.reply({"decision": "deny", "message": "x" * 9000})
        self.assertEqual(len(self.decision(self.run_hook())["message"]), 4000)

    def test_unknown_decision(self):
        self.reply({"decision": "maybe"})
        self.assertEqual(self.run_hook(), "")

    def test_non_200(self):
        self.reply({"decision": "allow", "answers": {}})
        for status in (500, 403, 204, 307):
            self.server.status = status
            self.assertEqual(self.run_hook(), "")

    def test_bad_json(self):
        for body in (b"not json", b"[]", b'"allow"', b""):
            self.server.body = body
            self.assertEqual(self.run_hook(), "")

    def test_connection_refused(self):
        self.stop()
        self.assertEqual(self.run_hook(), "")

    def test_config_missing(self):
        os.remove(os.path.join(self.dir, "claude-hook.json"))
        self.assertEqual(self.run_hook(), "")

    def test_config_permissions(self):
        self.reply({"decision": "deny"})
        for mode in (0o644, 0o640, 0o604, 0o660, 0o606):
            self.write_config({"socket": self.sock, "secret": SECRET}, mode)
            self.assertEqual(self.run_hook(), "", oct(mode))
        self.assertEqual(self.server.requests, [])

    def test_config_dir_permissions(self):
        self.reply({"decision": "deny"})
        for mode in (0o755, 0o750, 0o705, 0o770):
            os.chmod(self.dir, mode)
            self.assertEqual(self.run_hook(), "", oct(mode))
        os.chmod(self.dir, 0o700)
        self.assertEqual(self.decision(self.run_hook())["behavior"], "deny")
        self.assertEqual(len(self.server.requests), 1)

    def test_config_dir_symlink_refused(self):
        self.reply({"decision": "deny"})
        real = self.dir + ".real"
        os.rename(self.dir, real)
        os.symlink(real, self.dir)
        self.assertEqual(self.run_hook(), "")
        self.assertEqual(self.server.requests, [])

    def test_config_symlink_refused(self):
        path = self.write_config({"socket": self.sock, "secret": SECRET})
        real = path + ".real"
        os.rename(path, real)
        os.symlink(real, path)
        self.reply({"decision": "deny"})
        self.assertEqual(self.run_hook(), "")

    def test_config_too_large(self):
        self.reply({"decision": "deny"})
        self.write_config({"socket": self.sock, "secret": SECRET, "pad": "x" * 5000})
        self.assertEqual(self.run_hook(), "")

    def test_socket_outside_config_dir_refused(self):
        self.reply({"decision": "deny"})
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        elsewhere = Dashboard(os.path.join(other.name, "x.sock"))
        t = threading.Thread(target=elsewhere.serve_forever, args=(0.02,), daemon=True)
        t.start()
        self.addCleanup(lambda: (elsewhere.shutdown(), elsewhere.server_close()))
        sub = os.path.join(self.dir, "sub")
        os.mkdir(sub, 0o700)
        for sock in (os.path.join(other.name, "x.sock"), os.path.join(sub, "..", "claude-hook.sock"),
                     os.path.join(self.dir, "sub", "claude-hook.sock"), "claude-hook.sock", "", None, 5,
                     self.sock + "/", "unix://" + self.sock):
            self.write_config({"socket": sock, "secret": SECRET})
            self.assertEqual(self.run_hook(), "", repr(sock))
        self.assertEqual(self.server.requests + elsewhere.requests, [])

    def test_socket_not_a_socket_refused(self):
        self.reply({"decision": "deny"})
        self.stop()
        os.remove(self.sock)
        with open(self.sock, "w") as f:
            f.write("x")
        self.assertEqual(self.run_hook(), "")
        os.remove(self.sock)
        os.symlink(os.path.join(self.dir, "claude-hook.json"), self.sock)
        self.assertEqual(self.run_hook(), "")

    def test_socket_missing(self):
        self.stop()
        os.remove(self.sock)
        self.assertEqual(self.run_hook(), "")

    def test_bad_secrets(self):
        self.reply({"decision": "deny"})
        for secret in ("", "ab" * 31, "ab" * 33, "zz" * 32, "ab" * 32 + "\n", None, 5):
            self.write_config({"socket": self.sock, "secret": secret})
            self.assertEqual(self.run_hook(), "")
        self.assertEqual(self.server.requests, [])

    def test_bad_config_json(self):
        self.write_config("{nope")
        self.assertEqual(self.run_hook(), "")
        self.write_config("[]")
        self.assertEqual(self.run_hook(), "")

    def test_wrong_tool_or_event(self):
        self.reply({"decision": "deny"})
        for payload in (event("Bash"), event("Edit"), event(name="PreToolUse"), event(name="PostToolUse"),
                        {"tool_name": "AskUserQuestion"}, [], {"hook_event_name": "PermissionRequest"}):
            self.assertEqual(self.run_hook(payload), "")
        self.assertEqual(self.run_hook(raw="not json"), "")
        self.assertEqual(self.run_hook(raw=""), "")
        self.assertEqual(self.server.requests, [])

    def test_oversize_stdin(self):
        self.reply({"decision": "deny"})
        self.assertEqual(self.run_hook(event(tool_input={"x": "y" * (1024 * 1024 + 10)})), "")
        self.assertEqual(self.server.requests, [])

    def test_xdg_relative_falls_back_to_home(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        d = os.path.join(home.name, ".config", "swarmkit")
        os.makedirs(d, mode=0o700)
        os.chmod(d, 0o700)
        sock = os.path.join(d, "claude-hook.sock")
        server = Dashboard(sock)
        server.body = json.dumps({"decision": "deny", "message": "home"}).encode()
        t = threading.Thread(target=server.serve_forever, args=(0.02,), daemon=True)
        t.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        path = os.path.join(d, "claude-hook.json")
        with open(path, "w") as f:
            json.dump({"socket": sock, "secret": SECRET}, f)
        os.chmod(path, 0o600)
        d = self.decision(self.run_hook(env={"HOME": home.name, "XDG_CONFIG_HOME": "relative/dir"}))
        self.assertEqual(d["message"], "home")

    def test_xdg_is_trimmed_absolute_and_normalised(self):
        home = os.path.expanduser("~/.config/swarmkit")
        cases = {
            "  /a/b/../c/  ": "/a/c/swarmkit",
            "/a//b/./c": "/a/b/c/swarmkit",
            "relative/dir": home,
            "   ": home,
            "": home,
        }
        for value, want in cases.items():
            with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": value}):
                self.assertEqual(ask.config_dir(), want, repr(value))

    def connect(self):
        conn = ask.UnixHTTPConnection(self.sock, 5)
        try:
            conn.connect()
        finally:
            conn.close()

    @unittest.skipIf(getattr(socket, "SO_PEERCRED", None) is None, "needs SO_PEERCRED")
    def test_peer_uid_checked(self):
        self.connect()  # the real peer is this very user
        other = struct.pack("3i", os.getpid(), os.geteuid() + 1, os.getegid())
        with mock.patch.object(socket.socket, "getsockopt", return_value=other):
            with self.assertRaises(ask.Pass):
                self.connect()
        mine = struct.pack("3i", os.getpid(), os.geteuid(), os.getegid())
        with mock.patch.object(socket.socket, "getsockopt", return_value=mine):
            self.connect()

    def test_ancestors_checked_without_peercred(self):
        env = {"XDG_CONFIG_HOME": self.tmp.name}
        with mock.patch.dict(os.environ, env), mock.patch.object(socket, "SO_PEERCRED", None, create=True):
            self.assertEqual(ask.load_config()[0], self.sock)
            os.chmod(self.tmp.name, 0o777)  # group/other-writable parent, no sticky bit
            try:
                with self.assertRaises(ask.Pass):
                    ask.load_config()
                os.chmod(self.tmp.name, 0o1777)  # sticky: others cannot rename our entry
                self.assertEqual(ask.load_config()[0], self.sock)
            finally:
                os.chmod(self.tmp.name, 0o700)

    def test_ancestors_owned_by_someone_else_refused(self):
        real = os.lstat
        other = os.stat_result((0o40755, 0, 0, 1, os.geteuid() + 1, 0, 0, 0, 0, 0))
        with mock.patch.object(os, "lstat", side_effect=lambda p: other if p == self.tmp.name else real(p)):
            self.assertFalse(ask.ancestors_safe(self.dir))


if __name__ == "__main__":
    unittest.main()
