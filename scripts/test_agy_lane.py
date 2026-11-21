#!/usr/bin/env python3
"""Offline unittests for the quota-aware `lane` subcommand in scripts/agy-task: window headroom,
lane scoring, /usage JSON parsing, dual-read aggregation, fcntl-locked cache TTL/symlink safety,
running_by_lane counting, batch spreading, and CLI execution outside a git repo.

  python3 -m unittest scripts/test_agy_lane.py -v
"""
import contextlib, http.server, io, json, math, os, sqlite3, stat, subprocess, sys, tempfile, threading, time, unittest
from datetime import datetime, timezone
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

HERE = Path(__file__).resolve().parent
_loader = SourceFileLoader("agy_task_tested", str(HERE / "agy-task"))
_spec = spec_from_loader(_loader.name, _loader)
agy_task = module_from_spec(_spec)
_loader.exec_module(agy_task)

WEEK = 604800
NOW = datetime(2026, 11, 21, 12, 0, 0, tzinfo=timezone.utc).timestamp()


def iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def win(name, remaining, reset=None, length_s=None, limited=False):
    return {"name": name, "remaining": remaining, "reset": reset, "length_s": length_s, "limited": limited}


def reading(windows=(), fail=None, error=None):
    return {"fail": fail, "error": error, "windows": list(windows)}


def agy_payload(groups):
    return json.dumps({"status": "SUCCESS", "command": {"name": "usage", "data": {"groups": groups}}})


class PickLaneTests(unittest.TestCase):
    def test_agy_low_5h_picks_opencode(self):
        agy = reading([win("5h", 0.10, iso(NOW + 3600))])
        go = reading([win("rolling", 0.60, iso(NOW + 3600))])
        lane, _ = agy_task.pick_lane(agy, go, {"agy": 0, "opencode": 0}, NOW)
        self.assertEqual(lane, "opencode")

    def test_go_low_rolling_picks_agy(self):
        agy = reading([win("5h", 0.60, iso(NOW + 3600))])
        go = reading([win("rolling", 0.10, iso(NOW + 3600))])
        lane, _ = agy_task.pick_lane(agy, go, {"agy": 0, "opencode": 0}, NOW)
        self.assertEqual(lane, "agy")

    def test_running_penalty_breaks_tie(self):
        agy = reading([win("5h", 0.80)])
        go = reading([win("rolling", 0.80)])
        lane, reason = agy_task.pick_lane(agy, go, {"agy": 2, "opencode": 0}, NOW)
        self.assertEqual(lane, "opencode")
        self.assertIn("running agy 2 opencode 0", reason)

    def test_equal_prefers_agy(self):
        agy = reading([win("5h", 0.80)])
        go = reading([win("rolling", 0.80)])
        lane, _ = agy_task.pick_lane(agy, go, {"agy": 0, "opencode": 0}, NOW)
        self.assertEqual(lane, "agy")

    def test_blocked_agy_dropped_even_if_opencode_busy(self):
        agy = reading([win("5h", 0.03, iso(NOW + 3600))])
        go = reading([win("rolling", 0.20, iso(NOW + 3600))])
        lane, _ = agy_task.pick_lane(agy, go, {"agy": 0, "opencode": 5}, NOW)
        self.assertEqual(lane, "opencode")

    def test_agy_permanent_failure_picks_opencode(self):
        agy = reading(fail="permanent", error="agy not logged in")
        go = reading([win("rolling", 0.40)])
        lane, reason = agy_task.pick_lane(agy, go, {"agy": 0, "opencode": 0}, NOW)
        self.assertEqual(lane, "opencode")
        self.assertIn("blocked: agy not logged in", reason)

    def test_transient_agy_neutral_vs_high_go(self):
        agy = reading(fail="transient", error="agy usage timed out")
        go = reading([win("rolling", 0.90)])
        lane, reason = agy_task.pick_lane(agy, go, {"agy": 0, "opencode": 0}, NOW)
        self.assertEqual(lane, "opencode")
        self.assertIn("counted neutral", reason)

    def test_both_blocked_returns_none(self):
        agy = reading([win("5h", 0.02, iso(NOW + 100))])
        go = reading(fail="permanent", error="go missing")
        lane, reason = agy_task.pick_lane(agy, go, {"agy": 0, "opencode": 0}, NOW)
        self.assertIsNone(lane)
        self.assertIn("blocked", reason)

    def test_go_limited_is_blocked(self):
        agy = reading([win("5h", 0.30)])
        go = reading([win("rolling", 0.90, limited=True)])
        lane, reason = agy_task.pick_lane(agy, go, {"agy": 0, "opencode": 0}, NOW)
        self.assertEqual(lane, "agy")
        self.assertIn("go blocked", reason)
        lane2, reason2 = agy_task.pick_lane(reading(fail="permanent", error="no"), go, {"agy": 0, "opencode": 0}, NOW)
        self.assertIsNone(lane2)
        self.assertIn("blocked", reason2)


class WindowHeadroomTests(unittest.TestCase):
    def test_weekly_on_pace(self):
        w = win("weekly", 0.50, iso(NOW + 0.5 * WEEK), length_s=WEEK)
        self.assertAlmostEqual(agy_task.window_headroom(w, NOW), 0.50)

    def test_weekly_ahead_of_pace_penalized(self):
        w = win("weekly", 0.20, iso(NOW + 0.8 * WEEK), length_s=WEEK)
        self.assertAlmostEqual(agy_task.window_headroom(w, NOW), 0.05)

    def test_weekly_near_reset_never_boosted(self):
        w = win("weekly", 0.06, iso(NOW + 12 * 3600), length_s=WEEK)
        h = agy_task.window_headroom(w, NOW)
        self.assertLessEqual(h, 0.06)
        w_very_close = win("weekly", 0.06, iso(NOW + 60), length_s=WEEK)
        self.assertLessEqual(agy_task.window_headroom(w_very_close, NOW), 0.06)

    def test_reset_in_past_returns_one(self):
        w = win("weekly", 0.02, iso(NOW - 10), length_s=WEEK)
        self.assertEqual(agy_task.window_headroom(w, NOW), 1.0)

    def test_unparseable_reset_returns_remaining(self):
        w = win("weekly", 0.42, "not-a-timestamp", length_s=WEEK)
        self.assertEqual(agy_task.window_headroom(w, NOW), 0.42)

    def test_z_suffix_parsed(self):
        past = win("5h", 0.10, "2026-11-21T11:59:00Z")
        self.assertEqual(agy_task.window_headroom(past, NOW), 1.0)
        future = win("weekly", 0.20, "2026-11-27T02:24:00Z", length_s=WEEK)
        self.assertAlmostEqual(agy_task.window_headroom(future, NOW), 0.05)


class LaneCmdBatchTests(unittest.TestCase):
    def test_batch_spreads_across_lanes(self):
        agy = reading([win("5h", 0.80)])
        go = reading([win("rolling", 0.80)])
        orig_read, orig_run = agy_task.lane_readings, agy_task.running_by_lane
        agy_task.lane_readings = lambda now: (agy, go)
        agy_task.running_by_lane = lambda: {"agy": 0, "opencode": 0}
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                rc = agy_task.lane_cmd(3)
        finally:
            agy_task.lane_readings, agy_task.running_by_lane = orig_read, orig_run
        self.assertEqual(rc, 0)
        lanes = [line.split(" ", 1)[0] for line in buf.getvalue().splitlines()]
        self.assertEqual(lanes, ["agy", "opencode", "agy"])

    def test_both_blocked_exits_one(self):
        blocked_agy = reading(fail="permanent", error="not logged in")
        blocked_go = reading([win("rolling", 0.01, iso(NOW + 3600))])
        orig_read, orig_run = agy_task.lane_readings, agy_task.running_by_lane
        agy_task.lane_readings = lambda now: (blocked_agy, blocked_go)
        agy_task.running_by_lane = lambda: {"agy": 0, "opencode": 0}
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                rc = agy_task.lane_cmd(1)
        finally:
            agy_task.lane_readings, agy_task.running_by_lane = orig_read, orig_run
        self.assertEqual(rc, 1)
        self.assertTrue(buf.getvalue().startswith("none "), buf.getvalue())


class ParseAgyUsageTests(unittest.TestCase):
    def test_only_gemini_models_group_counted(self):
        out = agy_payload([
            {"name": "Gemini 4 Argon", "buckets": [
                {"window": "5h", "remaining_fraction": 0.01, "reset_time": "2026-11-21T17:00:00Z"},
            ]},
            {"name": "Gemini Models", "buckets": [
                {"window": "5h", "remaining_fraction": 0.97, "reset_time": "2026-11-21T17:00:22Z"},
                {"window": "weekly", "remaining_fraction": 0.98, "reset_time": "2026-11-28T12:00:22Z"},
            ]},
        ])
        ws = agy_task.parse_agy_usage(out)
        self.assertEqual({w["name"]: w["remaining"] for w in ws}, {"5h": 0.97, "weekly": 0.98})
        self.assertEqual({w["name"]: w["length_s"] for w in ws}, {"5h": None, "weekly": 604800})

    def test_invalid_fractions_skipped(self):
        out = agy_payload([{"name": "Gemini Models", "buckets": [
            {"window": "5h", "remaining_fraction": True, "reset_time": ""},
            {"window": "5h", "remaining_fraction": None},
            {"window": "5h", "remaining_fraction": math.nan},
            {"window": "weekly", "remaining_fraction": 0.75, "reset_time": ""},
        ]}])
        ws = agy_task.parse_agy_usage(out)
        self.assertEqual(len(ws), 1)
        self.assertEqual(ws[0]["name"], "weekly")
        self.assertEqual(ws[0]["remaining"], 0.75)
        self.assertIsNone(ws[0]["reset"])

    def test_status_not_success_raises_transient(self):
        with self.assertRaises(agy_task.LaneError) as ctx:
            agy_task.parse_agy_usage(json.dumps({"status": "ERROR"}))
        self.assertEqual(ctx.exception.kind, "transient")

    def test_not_logged_in_raises_permanent(self):
        with self.assertRaises(agy_task.LaneError) as ctx:
            agy_task.parse_agy_usage("Error: User is Not Logged In")
        self.assertEqual(ctx.exception.kind, "permanent")

    def test_bad_json_raises_transient(self):
        with self.assertRaises(agy_task.LaneError) as ctx:
            agy_task.parse_agy_usage("{not json")
        self.assertEqual(ctx.exception.kind, "transient")


class AgyReadingTests(unittest.TestCase):
    def test_lowest_of_two_per_window(self):
        calls = iter([
            agy_payload([{"name": "Gemini Models", "buckets": [
                {"window": "5h", "remaining_fraction": 0.80, "reset_time": "2026-11-21T16:00:00Z"},
                {"window": "weekly", "remaining_fraction": 0.50, "reset_time": "2026-11-28T12:00:00Z"},
            ]}]),
            agy_payload([{"name": "Gemini Models", "buckets": [
                {"window": "5h", "remaining_fraction": 0.65, "reset_time": "2026-11-21T17:00:00Z"},
                {"window": "weekly", "remaining_fraction": 0.70, "reset_time": "2026-11-28T13:00:00Z"},
            ]}]),
        ])
        r = agy_task.agy_reading(run=lambda: next(calls))
        self.assertIsNone(r["fail"])
        by_name = {w["name"]: w for w in r["windows"]}
        self.assertEqual(by_name["5h"]["remaining"], 0.65)
        self.assertEqual(by_name["5h"]["reset"], "2026-11-21T17:00:00Z")
        self.assertEqual(by_name["weekly"]["remaining"], 0.50)
        self.assertEqual(by_name["weekly"]["reset"], "2026-11-28T12:00:00Z")

    def test_one_transient_uses_other(self):
        step = [0]
        def fake():
            step[0] += 1
            if step[0] == 1:
                raise agy_task.LaneError("transient", "timeout")
            return agy_payload([{"name": "Gemini Models", "buckets": [
                {"window": "5h", "remaining_fraction": 0.90, "reset_time": "2026-11-21T17:00:00Z"},
            ]}])
        r = agy_task.agy_reading(run=fake)
        self.assertIsNone(r["fail"])
        self.assertEqual(len(r["windows"]), 1)
        self.assertEqual(r["windows"][0]["remaining"], 0.90)

    def test_both_fail_permanent_beats_transient(self):
        step = [0]
        def fake():
            step[0] += 1
            if step[0] == 1:
                raise agy_task.LaneError("transient", "timeout")
            raise agy_task.LaneError("permanent", "agy not logged in")
        r = agy_task.agy_reading(run=fake)
        self.assertEqual(r["fail"], "permanent")
        self.assertEqual(r["error"], "agy not logged in")
        self.assertEqual(r["windows"], [])


class LaneCacheTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.old = os.environ.get("SWARMKIT_LANE_CACHE")
        self.cache = Path(self.d.name) / "lane.json"
        os.environ["SWARMKIT_LANE_CACHE"] = str(self.cache)

    def tearDown(self):
        if self.old is None:
            os.environ.pop("SWARMKIT_LANE_CACHE", None)
        else:
            os.environ["SWARMKIT_LANE_CACHE"] = self.old
        self.d.cleanup()

    def test_cached_within_ttl_and_mode_0600(self):
        counts = {"agy": 0, "go": 0}
        def fa():
            counts["agy"] += 1
            return reading([win("5h", 0.80)])
        def fg():
            counts["go"] += 1
            return reading([win("rolling", 0.70)])
        r1 = agy_task.lane_readings(NOW, fetch_agy=fa, fetch_go=fg)
        r2 = agy_task.lane_readings(NOW + 30, fetch_agy=fa, fetch_go=fg)
        self.assertEqual(counts, {"agy": 1, "go": 1})
        self.assertEqual(r1, r2)
        self.assertEqual(stat.S_IMODE(self.cache.stat().st_mode), 0o600)

    def test_transient_expires_at_61s_while_ok_stays_cached(self):
        counts = {"agy": 0, "go": 0}
        def fa():
            counts["agy"] += 1
            return reading([win("5h", 0.80)])
        def fg():
            counts["go"] += 1
            return reading(fail="transient", error="stub")
        agy_task.lane_readings(NOW, fetch_agy=fa, fetch_go=fg)
        agy_task.lane_readings(NOW + 61, fetch_agy=fa, fetch_go=fg)
        self.assertEqual(counts, {"agy": 1, "go": 2})

    def test_symlink_at_cache_path_not_followed(self):
        target = Path(self.d.name) / "victim.json"
        target.write_text(json.dumps({
            "agy": {"at": NOW, "reading": reading([win("5h", 0.11)])},
            "opencode": {"at": NOW, "reading": reading([win("rolling", 0.22)])},
        }))
        os.symlink(target, self.cache)
        counts = {"agy": 0, "go": 0}
        def fa():
            counts["agy"] += 1
            return reading([win("5h", 0.95)])
        def fg():
            counts["go"] += 1
            return reading([win("rolling", 0.85)])
        a, g = agy_task.lane_readings(NOW, fetch_agy=fa, fetch_go=fg)
        self.assertEqual(counts, {"agy": 1, "go": 1})
        self.assertEqual(a["windows"][0]["remaining"], 0.95)
        self.assertEqual(g["windows"][0]["remaining"], 0.85)
        self.assertEqual(json.loads(target.read_text())["agy"]["reading"]["windows"][0]["remaining"], 0.11)
        self.assertFalse(self.cache.is_symlink())

    def _counting(self):
        counts = {"agy": 0, "go": 0}
        def fa():
            counts["agy"] += 1
            return reading([win("5h", 0.9)])
        def fg():
            counts["go"] += 1
            return reading([win("rolling", 0.8)])
        return counts, fa, fg

    def test_corrupt_cached_window_is_refetched(self):
        bad = {"name": "5h", "remaining": "\x1b[31m", "reset": None, "length_s": None, "limited": False}
        self.cache.write_text(json.dumps({"agy": {"at": NOW, "reading": reading([bad])},
                                          "opencode": {"at": NOW, "reading": reading([win("rolling", 0.5)])}}))
        counts, fa, fg = self._counting()
        a, g = agy_task.lane_readings(NOW, fetch_agy=fa, fetch_go=fg)
        self.assertEqual(counts, {"agy": 1, "go": 0})
        self.assertEqual(a["windows"][0]["remaining"], 0.9)

    def test_fifo_at_cache_or_lock_path_does_not_hang(self):
        os.mkfifo(self.cache)
        counts, fa, fg = self._counting()
        a, _ = agy_task.lane_readings(NOW, fetch_agy=fa, fetch_go=fg)
        self.assertEqual(a["windows"][0]["remaining"], 0.9)
        self.cache.unlink()
        os.unlink(f"{self.cache}.lock")
        os.mkfifo(f"{self.cache}.lock")
        a, _ = agy_task.lane_readings(NOW, fetch_agy=fa, fetch_go=fg)
        self.assertEqual(counts, {"agy": 2, "go": 2})  # read live, cached nothing
        self.assertFalse(self.cache.exists())

    def test_slow_fetcher_hits_the_deadline(self):
        old = agy_task.LANE_FETCH_DEADLINE_S
        agy_task.LANE_FETCH_DEADLINE_S = 0.2
        try:
            t = time.monotonic()
            a, g = agy_task.lane_readings(NOW, fetch_agy=lambda: time.sleep(5), fetch_go=lambda: reading([win("rolling", 0.8)]))
        finally:
            agy_task.LANE_FETCH_DEADLINE_S = old
        self.assertLess(time.monotonic() - t, 2)
        self.assertEqual(a["fail"], "transient")
        self.assertIsNone(g["fail"])

    def test_crashing_fetcher_is_transient(self):
        a, _ = agy_task.lane_readings(NOW, fetch_agy=lambda: 1 / 0, fetch_go=lambda: reading([win("rolling", 0.8)]))
        self.assertEqual(a["fail"], "transient")

    def test_held_lock_times_out(self):
        import fcntl
        fd = os.open(f"{self.cache}.lock", os.O_CREAT | os.O_WRONLY, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        old = agy_task.LANE_LOCK_WAIT_S
        agy_task.LANE_LOCK_WAIT_S = 0.6
        try:
            # flock locks belong to the open file description, so our own second open conflicts too
            a, g = agy_task.lane_readings(NOW, fetch_agy=lambda: 1 / 0, fetch_go=lambda: 1 / 0)
        finally:
            agy_task.LANE_LOCK_WAIT_S = old
            os.close(fd)
        self.assertEqual((a["error"], g["fail"]), ("lane cache lock busy", "transient"))


class RunningByLaneTests(unittest.TestCase):
    def test_counts_alive_pids_per_backend(self):
        with tempfile.TemporaryDirectory() as d_agy, tempfile.TemporaryDirectory() as d_go:
            old_agy = os.environ.get("AGY_TASK_DIR")
            old_go = os.environ.get("OPENCODE_TASK_DIR")
            os.environ["AGY_TASK_DIR"] = d_agy
            os.environ["OPENCODE_TASK_DIR"] = d_go
            for slug in ("t1", "t2"):
                p = Path(d_agy, "repo-1", slug)
                p.mkdir(parents=True)
                (p / "pid").write_text(str(os.getpid()))
            p_go = Path(d_go, "repo-2", "t3")
            p_go.mkdir(parents=True)
            (p_go / "pid").write_text(str(os.getpid()))
            orig_alive = agy_task.alive
            agy_task.alive = lambda pidfile: True
            try:
                counts = agy_task.running_by_lane()
            finally:
                agy_task.alive = orig_alive
                for k, v in (("AGY_TASK_DIR", old_agy), ("OPENCODE_TASK_DIR", old_go)):
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
        self.assertEqual(counts, {"agy": 2, "opencode": 1})


class LaneCliTests(unittest.TestCase):
    def test_cli_outside_git_repo_uses_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "lane.json"
            now = time.time()
            cache.write_text(json.dumps({
                "agy": {"at": now, "reading": reading([win("5h", 0.90, iso(now + 3600))])},
                "opencode": {"at": now, "reading": reading([win("rolling", 0.40, iso(now + 3600))])},
            }))
            env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "OPENCODE", "SWARMKIT_AGY_LEAD")}
            env["SWARMKIT_LANE_CACHE"] = str(cache)
            env["AGY_TASK_DIR"] = str(Path(tmp) / "agy-tasks")
            env["OPENCODE_TASK_DIR"] = str(Path(tmp) / "go-tasks")
            r = subprocess.run([sys.executable, str(HERE / "agy-task"), "lane"], cwd=tmp, env=env,
                               capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(r.stdout.startswith(("agy ", "opencode ")), r.stdout)


TOKEN = "sk-test-0f3a-not-real"


class GoParseTests(unittest.TestCase):
    def test_new_shape_with_resets_at(self):
        w = agy_task.parse_go_usage(json.dumps({"usage": {
            "rolling": {"percent": 40, "resetsAt": "2026-11-21T15:00:00Z"},
            "weekly": {"usagePercent": 10, "resetsAt": "2026-11-25T00:00:00.000Z"},
            "monthly": {"percent": 0, "status": "rate-limited"}}}), NOW)
        by = {x["name"]: x for x in w}
        self.assertAlmostEqual(by["rolling"]["remaining"], 0.6)
        self.assertIsNone(by["rolling"]["length_s"])
        self.assertEqual(by["weekly"]["length_s"], 7 * 86400)
        self.assertAlmostEqual(by["weekly"]["remaining"], 0.9)
        self.assertTrue(by["monthly"]["limited"])
        self.assertIsNone(by["monthly"]["reset"])

    def test_legacy_shape_with_reset_in_sec(self):
        w = agy_task.parse_go_usage(json.dumps({"rollingUsage": {"usagePercent": 150, "resetInSec": 3600}}), NOW)
        self.assertEqual(w[0]["remaining"], 0.0)  # clamped
        self.assertEqual(agy_task._parse_reset(w[0]["reset"]), NOW + 3600)

    def test_bad_answers_are_transient(self):
        for body in ("nope", "[]", json.dumps({}), json.dumps({"usage": {"rolling": {"percent": True}}}),
                     json.dumps({"usage": {"rolling": "x"}})):
            with self.assertRaises(agy_task.LaneError) as c:
                agy_task.parse_go_usage(body, NOW)
            self.assertEqual(c.exception.kind, "transient", body)

    def test_out_of_range_reset_in_sec_ignored(self):
        w = agy_task.parse_go_usage(json.dumps({"usage": {"weekly": {"percent": 5, "resetInSec": -1}}}), NOW)
        self.assertIsNone(w[0]["reset"])


class GoCredentialTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.old = os.environ.get("XDG_DATA_HOME")
        os.environ["XDG_DATA_HOME"] = self.d.name
        self.dir = Path(self.d.name) / "opencode"
        self.dir.mkdir()

    def tearDown(self):
        if self.old is None:
            os.environ.pop("XDG_DATA_HOME", None)
        else:
            os.environ["XDG_DATA_HOME"] = self.old
        self.d.cleanup()

    def make_db(self, rows=(), table=True):
        conn = sqlite3.connect(self.dir / "opencode.db")
        if table:
            conn.execute("CREATE TABLE credential (integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)")
            conn.executemany("INSERT INTO credential VALUES (?, ?, ?, ?)", rows)
        else:
            conn.execute("CREATE TABLE other (x)")
        conn.commit()
        conn.close()

    def kind(self):
        with self.assertRaises(agy_task.LaneError) as c:
            agy_task._go_credential()
        return c.exception.kind, str(c.exception)

    def test_db_prefers_go_then_newest_and_skips_inactive(self):
        self.make_db([
            ("opencode", json.dumps({"type": "api", "key": "zen"}), 1, 9),
            ("opencode-go", json.dumps({"type": "api", "key": "old"}), 1, 1),
            ("opencode-go", json.dumps({"type": "oauth", "access": "new", "metadata": {"orgID": "org1"}}), 1, 5),
            ("opencode-go", json.dumps({"type": "api", "key": "off"}), 0, 99)])
        self.assertEqual(agy_task._go_credential(), ("new", "org1"))

    def test_db_skips_unusable_rows_and_crlf(self):
        self.make_db([("opencode-go", "not json", 1, 9),
                      ("opencode-go", json.dumps({"type": "api", "key": "a\r\nb"}), 1, 8),
                      ("opencode", json.dumps({"type": "key", "key": "zen", "metadata": {"orgID": "x\ny"}}), 1, 1)])
        self.assertEqual(agy_task._go_credential(), ("zen", None))

    def test_empty_table_is_not_signed_in_even_with_auth_json(self):
        self.make_db([])
        (self.dir / "auth.json").write_text(json.dumps({"opencode-go": {"type": "api", "key": "stale"}}))
        self.assertEqual(self.kind()[0], "permanent")

    def test_no_table_falls_back_to_auth_json(self):
        self.make_db(table=False)
        (self.dir / "auth.json").write_text(json.dumps({"opencode": {"type": "api", "key": "zen"},
                                                        "opencode-go": {"type": "oauth", "access": "go"}}))
        self.assertEqual(agy_task._go_credential(), ("go", None))

    def test_not_a_database_falls_back(self):
        (self.dir / "opencode.db").write_bytes(b"garbage" * 200)
        (self.dir / "auth.json").write_text(json.dumps({"opencode": {"type": "api", "key": "zen"}}))
        self.assertEqual(agy_task._go_credential(), ("zen", None))

    def test_locked_db_is_transient_without_fallback(self):
        self.make_db([("opencode-go", json.dumps({"type": "api", "key": "k"}), 1, 1)])
        (self.dir / "auth.json").write_text(json.dumps({"opencode-go": {"type": "api", "key": "file"}}))
        holder = sqlite3.connect(self.dir / "opencode.db", isolation_level=None)
        holder.execute("BEGIN EXCLUSIVE")
        try:
            self.assertEqual(self.kind()[0], "transient")
        finally:
            holder.execute("ROLLBACK")
            holder.close()

    def test_nothing_is_not_signed_in(self):
        self.assertEqual(self.kind(), ("permanent", "opencode not signed in"))

    def test_symlinked_auth_json_refused(self):
        real = Path(self.d.name) / "real.json"
        real.write_text(json.dumps({"opencode-go": {"type": "api", "key": "k"}}))
        os.symlink(real, self.dir / "auth.json")
        self.assertEqual(self.kind()[0], "permanent")

    def test_relative_xdg_ignored(self):
        os.environ["XDG_DATA_HOME"] = "relative/dir"
        self.assertEqual(agy_task._go_data_dir(), Path.home() / ".local" / "share" / "opencode")


class _Handler(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_GET(self):
        type(self).seen.append(dict(self.headers))
        mode = self.server.mode
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/elsewhere")
            self.end_headers()
            return
        code, body = {"ok": (200, json.dumps({"usage": {"rolling": {"percent": 30}}})),
                      "401": (401, TOKEN), "403": (403, TOKEN), "500": (500, TOKEN),
                      "big": (200, "x" * (agy_task.GO_MAX_BYTES + 10)),
                      "truncated": (200, '{"usage": {'), "nested": (200, "[" * 60000)}[mode]
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(data) + (100 if mode == "truncated" else 0)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class GoFetchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.old_url = agy_task.GO_USAGE_URL
        agy_task.GO_USAGE_URL = f"http://127.0.0.1:{cls.srv.server_port}/usage"

    @classmethod
    def tearDownClass(cls):
        agy_task.GO_USAGE_URL = cls.old_url
        cls.srv.shutdown()
        cls.srv.server_close()

    def fetch(self, mode):
        self.srv.mode = mode
        _Handler.seen.clear()
        return self._read()

    def _read(self):
        orig = agy_task._go_credential
        agy_task._go_credential = lambda: (TOKEN, "org9")
        try:
            return agy_task.go_reading(now=NOW)
        finally:
            agy_task._go_credential = orig

    def test_ok_sends_bearer_and_org(self):
        r = self.fetch("ok")
        self.assertIsNone(r["fail"])
        self.assertAlmostEqual(r["windows"][0]["remaining"], 0.7)
        h = {k.lower(): v for k, v in _Handler.seen[0].items()}
        self.assertEqual(h["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(h["x-opencode-org-id"], "org9")

    def test_status_codes(self):
        for mode, kind in (("401", "permanent"), ("403", "permanent"), ("500", "transient"), ("big", "transient"),
                           ("truncated", "transient"), ("nested", "transient")):
            r = self.fetch(mode)
            self.assertEqual(r["fail"], kind, mode)
            self.assertNotIn(TOKEN, json.dumps(r))

    def test_redirect_not_followed(self):
        r = self.fetch("redirect")
        self.assertEqual(r["fail"], "transient")
        self.assertEqual(len(_Handler.seen), 1)  # the bearer token never went to the second URL

    def test_cache_never_holds_the_token(self):
        self.srv.mode = "ok"
        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get("SWARMKIT_LANE_CACHE")
            os.environ["SWARMKIT_LANE_CACHE"] = str(Path(d) / "lane.json")
            try:
                agy_task.lane_readings(NOW, fetch_agy=lambda: reading([win("5h", 0.5)]), fetch_go=self._read)
                text = (Path(d) / "lane.json").read_text()
            finally:
                if old is None:
                    os.environ.pop("SWARMKIT_LANE_CACHE", None)
                else:
                    os.environ["SWARMKIT_LANE_CACHE"] = old
        self.assertNotIn(TOKEN, text)
        self.assertNotIn("org9", text)
        self.assertEqual(set(json.loads(text)), {"agy", "opencode"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
