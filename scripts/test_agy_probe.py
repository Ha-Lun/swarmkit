#!/usr/bin/env python3
"""Offline unittests for the automatic agy gate probe in scripts/agy-task: the pass criteria from fake
transcript tool-call lists and gate-log fixtures, the transcript call parser, the probe state file, the
fcntl-locked run decision and the version gate. No agy is invoked (see 'agy gate' in agy-task --help).

  python3 -m unittest scripts/test_agy_probe.py -v
"""
import json, os, stat, sys, tempfile, unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

HERE = Path(__file__).resolve().parent
_loader = SourceFileLoader("agy_task_tested", str(HERE / "agy-task"))
_spec = spec_from_loader(_loader.name, _loader)
agy_task = module_from_spec(_spec)
_loader.exec_module(agy_task)  # __name__ is not __main__: main() does not run

WT = "/tmp/probe-wt"
ESCAPE = "/tmp/probe-escape/escape-0f3a.txt"
MARKER = "MARKER-0f3a"


def good_calls():
    """A transcript the gate let through: reads, the asked edits, a search, then the denied escape."""
    return [{"name": "read_file", "args": {"Path": f"{WT}/a.txt"}},
            {"name": "read_file", "args": {"Path": f"{WT}/sub/b.txt"}},
            {"name": "edit_file", "args": {"Path": f"{WT}/a.txt", "Target": MARKER, "Replacement": "REPLACED"}},
            {"name": "write_file", "args": {"Path": f"{WT}/c.txt", "Content": "done"}},
            {"name": "grep_search", "args": {"SearchPath": WT, "Query": "needle"}},
            {"name": "write_file", "args": {"Path": ESCAPE, "Content": "outside"}}]


def good_log():
    """The gate log matching good_calls() one to one, the escape write denied."""
    return [f"allow read_file {WT}/a.txt",
            f"allow read_file {WT}/sub/b.txt",
            f"allow edit_file {WT}/a.txt",
            f"allow write_file {WT}/c.txt",
            f"allow grep_search {WT}",
            f"deny write_file {ESCAPE}"]


def problems(calls, log, edits_ok=True, escape_absent=True, clean_git=True):
    return agy_task.agy_probe_problems(calls, log, edits_ok, ESCAPE, escape_absent, clean_git)


class ProbeCriteria(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(problems(good_calls(), good_log()), [])

    def test_unknown_tool_denied_is_fine(self):
        calls = good_calls() + [{"name": "browser_click", "args": {"Selector": "#x"}}]
        log = good_log() + ["deny browser_click #x"]
        self.assertEqual(problems(calls, log), [])

    def test_unknown_tool_allowed(self):
        calls = good_calls() + [{"name": "browser_click", "args": {"Selector": "#x"}}]
        log = good_log() + ["allow browser_click #x"]
        ps = problems(calls, log)
        self.assertTrue(any("unknown tool allowed" in p and "browser_click" in p for p in ps), ps)

    def test_unknown_arg_key(self):
        calls = good_calls()
        calls[2]["args"]["Bypass"] = "yes"
        ps = problems(calls, good_log())
        self.assertTrue(any("unknown argument key Bypass" in p and "edit_file" in p for p in ps), ps)

    def test_unknown_arg_key_denied_is_fine(self):
        calls = good_calls()
        calls[2]["args"]["Bypass"] = "yes"
        log = good_log()[:2] + ["deny edit_file /x"] + good_log()[3:]
        self.assertEqual(problems(calls, log), [])

    def test_escape_not_denied(self):
        ps = problems(good_calls(), good_log()[:-1])
        self.assertTrue(any("not denied" in p for p in ps), ps)
        self.assertTrue(any("gate mismatch" in p for p in ps), ps)  # one call now has no decision

    def test_gate_mismatch(self):
        log = good_log()[:3] + good_log()[4:]  # one allow dropped: the counts no longer line up
        ps = problems(good_calls(), log)
        self.assertTrue(any(p.startswith("gate mismatch") for p in ps), ps)

    def test_no_gate_log_means_inactive_hook(self):
        ps = problems(good_calls(), [])
        self.assertTrue(any("gate mismatch" in p for p in ps), ps)

    def test_unreadable_transcript(self):
        ps = problems(None, good_log())
        self.assertEqual(len(ps), 1)
        self.assertIn("gate check unavailable", ps[0])

    def test_missing_edits(self):
        ps = problems(good_calls(), good_log(), edits_ok=False)
        self.assertTrue(any("edits did not happen" in p for p in ps), ps)

    def test_escape_file_exists(self):
        ps = problems(good_calls(), good_log(), escape_absent=False)
        self.assertTrue(any("escape file exists" in p for p in ps), ps)

    def test_git_changed(self):
        ps = problems(good_calls(), good_log(), clean_git=False)
        self.assertTrue(any(".git changed" in p for p in ps), ps)


class ProbeCalls(unittest.TestCase):
    def test_parse_and_invalid_skip(self):
        conv = "12345678-1234-1234-1234-123456789012"
        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get("SWARMKIT_AGY_BRAIN_DIR")
            os.environ["SWARMKIT_AGY_BRAIN_DIR"] = d
            try:
                log = Path(d, conv, ".system_generated", "logs")
                log.mkdir(parents=True)
                steps = [{"tool_calls": [{"name": "read_file", "args": {"Path": "/w/a.txt"}}]},  # next INVALID: skipped
                         {"status": "INVALID"},
                         {"tool_calls": [{"name": "write_file", "args": {"Path": "/w/c.txt", "Content": "done"}}]},
                         "{ broken json line",
                         {"tool_calls": [{"name": "grep_search", "args": {"SearchPath": "/w", "Query": "needle"}},
                                         {"name": "read_file", "args": {"Path": "/w/b.txt"}}]}]
                (log / "transcript_full.jsonl").write_text("\n".join(json.dumps(s) if isinstance(s, dict) else s
                                                                    for s in steps))
                calls = agy_task.agy_probe_calls(conv)
            finally:
                if old is None:
                    os.environ.pop("SWARMKIT_AGY_BRAIN_DIR", None)
                else:
                    os.environ["SWARMKIT_AGY_BRAIN_DIR"] = old
        self.assertEqual([c["name"] for c in calls], ["write_file", "grep_search", "read_file"])
        self.assertEqual(calls[0]["args"], {"Path": "/w/c.txt", "Content": "done"})

    def test_unreadable_transcript(self):
        self.assertIsNone(agy_task.agy_probe_calls("no-such-conversation-id-at-all"))

    def test_gate_schema_imported(self):
        schema, common = agy_task.agy_gate_schema()
        for n in ("read_file", "edit_file", "write_file", "grep_search"):
            self.assertIn(n, schema)
        self.assertIn("Path", schema["edit_file"][0])
        self.assertIn("toolAction", common)


class ProbeState(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AGY_TASK_DIR")
        os.environ["AGY_TASK_DIR"] = self.d.name
        self.p = Path(self.d.name, "probed-versions.json")

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AGY_TASK_DIR", None)
        else:
            os.environ["AGY_TASK_DIR"] = self.old
        self.d.cleanup()

    def test_record_and_read(self):
        self.assertTrue(agy_task.record_probed_version("1.5.12", ["read_file", "edit_file"]))
        self.assertEqual(agy_task.probed_versions(), ["1.5.12"])
        self.assertEqual(stat.S_IMODE(self.p.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(Path(self.d.name).stat().st_mode), 0o700)
        rec = json.loads(self.p.read_text())[0]
        self.assertEqual(rec["version"], "1.5.12")
        self.assertEqual(rec["agy_tool_names"], ["read_file", "edit_file"])
        self.assertIn("probed_at", rec)

    def test_records_append(self):
        agy_task.record_probed_version("1.5.10", ["read_file"])
        agy_task.record_probed_version("1.5.12", ["read_file", "write_file"])
        self.assertEqual(agy_task.probed_versions(), ["1.5.10", "1.5.12"])
        self.assertEqual(sorted(x.name for x in Path(self.d.name).iterdir()),
                         ["probed-versions.json"])  # no leftover tmp files

    def test_corrupt_state_reads_as_unprobed(self):
        self.p.write_text("{ not json")
        self.assertEqual(agy_task.probed_versions(), [])
        self.assertTrue(agy_task.record_probed_version("1.5.12", []))  # a fresh list heals the file
        self.assertEqual(agy_task.probed_versions(), ["1.5.12"])


class ProbeLock(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AGY_TASK_DIR")
        os.environ["AGY_TASK_DIR"] = self.d.name
        agy_task.record_probed_version("1.5.12", [])

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AGY_TASK_DIR", None)
        else:
            os.environ["AGY_TASK_DIR"] = self.old
        self.d.cleanup()

    def test_already_probed_skips_the_run(self):
        def boom(version):
            raise AssertionError("run_probe must not run for a recorded version")
        orig, agy_task.run_probe = agy_task.run_probe, boom
        try:
            self.assertEqual(agy_task.run_probe_locked("1.5.12"), 0)
        finally:
            agy_task.run_probe = orig

    def test_unprobed_runs(self):
        orig = agy_task.run_probe
        seen = []
        agy_task.run_probe = lambda version: seen.append(version) or 0
        try:
            self.assertEqual(agy_task.run_probe_locked("1.5.13"), 0)
        finally:
            agy_task.run_probe = orig
        self.assertEqual(seen, ["1.5.13"])


class VersionGate(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.old = os.environ.get("AGY_TASK_DIR")
        os.environ["AGY_TASK_DIR"] = self.d.name
        agy_task.record_probed_version("1.5.12", [])

    def tearDown(self):
        if self.old is None:
            os.environ.pop("AGY_TASK_DIR", None)
        else:
            os.environ["AGY_TASK_DIR"] = self.old
        self.d.cleanup()

    def decide(self, version, **kw):
        return agy_task.agy_gate_decision(version, **kw)

    def test_recorded_version_proceeds(self):
        self.assertEqual(self.decide("1.5.12"), "proceed")

    def test_agy_probed_proceeds(self):
        self.assertEqual(self.decide(agy_task.AGY_PROBED), "proceed")

    def test_unprobed_probes(self):
        self.assertEqual(self.decide("9.9.9"), "probe")

    def test_override(self):
        self.assertEqual(self.decide("9.9.9", override="1"), "override")

    def test_unknown_version(self):
        self.assertEqual(self.decide(None), "unknown")
        self.assertEqual(self.decide(None, override="1"), "override")  # the manual override still wins

    def test_yolo_never_probes(self):
        self.assertEqual(self.decide("9.9.9", yolo=True), "proceed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
