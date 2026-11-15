"""Tests for usage-steer.py. Run: python3 -I claude/hooks/test_usage_steer.py"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usage-steer.py")
spec = importlib.util.spec_from_file_location("usage_steer", HOOK)
steer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(steer)
TOKEN = "t" * 40


def report(five=None, week=None, agy=0, oc=0, oc_limited=False):
    return {
        "claude": {"available": True, "fiveHour": {"utilization": five}, "sevenDay": {"utilization": week}},
        "agy": {"limits": [{"group": "Gemini", "window": "5h", "utilization": agy},
                           {"group": "Claude/GPT", "window": "5h", "utilization": 99}]},
        "opencode": {"limits": [{"window": "rolling", "utilization": oc, "limited": oc_limited}]},
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        srv = self.server
        srv.seen.append((self.path, self.headers.get("x-fleet-token")))
        body = srv.body if isinstance(srv.body, bytes) else json.dumps(srv.body).encode()
        self.send_response(srv.status)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.tmp.name, "swarmkit"))
        with open(os.path.join(self.tmp.name, "swarmkit", "token"), "w") as f:
            f.write(TOKEN + "\n")
        self.srv = HTTPServer(("127.0.0.1", 0), Handler)
        self.srv.seen, self.srv.status, self.srv.body = [], 200, report()
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def run_hook(self, port=None):
        env = {**os.environ, "XDG_CONFIG_HOME": self.tmp.name,
               "SWARMKIT_PORT": str(port or self.srv.server_address[1])}
        p = subprocess.run([sys.executable, "-I", HOOK], input='{"prompt":"hi"}', capture_output=True,
                           text=True, env=env, timeout=10)
        self.assertEqual(p.returncode, 0)
        return json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"] if p.stdout.strip() else None

    def test_below_threshold_is_silent(self):
        self.srv.body = report(five=69, week=40)
        self.assertIsNone(self.run_hook())
        self.assertEqual(self.srv.seen, [("/api/usage", TOKEN)])

    def test_steer_band(self):
        self.srv.body = report(five=30, week=75, agy=10, oc=5)
        text = self.run_hook()
        self.assertIn("75%", text)
        self.assertIn("Send all implementation", text)
        self.assertIn("agy 10%", text)
        self.assertIn("OpenCode 5%", text)

    def test_handoff_band_and_full_lane(self):
        self.srv.body = report(five=93, week=60, agy=97, oc=20)
        text = self.run_hook()
        self.assertIn("Hand the rest of this task", text)
        self.assertIn("agy is near its limit: use OpenCode", text)

    def test_both_lanes_full(self):
        self.srv.body = report(five=80, agy=96, oc_limited=True)
        self.assertIn("Both worker lanes", self.run_hook())

    def test_fails_open(self):
        for status, body in ((500, report(five=95)), (200, b"not json"), (200, {"claude": None})):
            self.srv.status, self.srv.body = status, body
            self.assertIsNone(self.run_hook())
        self.srv.status = 200
        self.srv.body = report(five=95)
        os.remove(os.path.join(self.tmp.name, "swarmkit", "token"))
        self.assertIsNone(self.run_hook())

    def test_dashboard_down(self):
        port = self.srv.server_address[1]
        self.srv.shutdown()
        self.srv.server_close()
        self.srv = HTTPServer(("127.0.0.1", 0), Handler)  # replaced so tearDown has something to stop
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.assertIsNone(self.run_hook(port=port))

    def test_note_ignores_bad_numbers(self):
        self.assertIsNone(steer.note({"claude": {"fiveHour": {"utilization": True}}}))
        self.assertIsNone(steer.note({}))


if __name__ == "__main__":
    unittest.main()
